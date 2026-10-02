import type { Page } from "@playwright/test"
import { test, expect, launchElectronApp } from "../fixtures"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VIDEO_A = path.resolve(__dirname, "../../../data/videos/TEST2__h264_60fps_1080.mp4")
const VIDEO_B = path.resolve(__dirname, "../../../data/videos/TEST2__hevc_60fps_1080.mp4")

/** 经左侧手动输入框添加素材（与 06-phase1 同一套流程） */
async function addInputs(page: Page, files: string[]): Promise<void> {
  for (const p of files) {
    await page.locator('[data-testid="input-manual-path"]').fill(p)
    await page.locator('[data-testid="btn-manual-add"]').click()
  }
  await expect(page.locator('[data-testid="task-row"]')).toHaveCount(files.length, {
    timeout: 20000,
  })
}

/** 读取 queue.json 的条目文件名顺序；文件缺失/损坏时返回 null（供 poll 重试） */
async function readQueueNames(queuePath: string): Promise<string[] | null> {
  try {
    const raw = JSON.parse(await readFile(queuePath, "utf8")) as { items?: unknown }
    const items = Array.isArray(raw.items) ? raw.items : []
    return items.map((i) => path.basename(String((i as { path?: unknown }).path ?? "")))
  } catch {
    return null
  }
}

test.describe("Phase2 - 持久化转码队列 (PR1)", () => {
  test("队列跨重启恢复：顺序一致、状态为待扫描、绝不自动开始", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "mediac-e2e-"))
    const queuePath = path.join(userDataDir, "queue.json")

    try {
      // ---- 第一次启动：加入两个素材，队列随 staging 写穿落盘 ----
      const first = await launchElectronApp(userDataDir)
      await addInputs(first.page, [VIDEO_A, VIDEO_B])

      await expect
        .poll(() => readQueueNames(queuePath), { timeout: 8000 })
        .toEqual([path.basename(VIDEO_A), path.basename(VIDEO_B)])

      // 高危开关绝不进入持久化形状
      const persisted = JSON.parse(await readFile(queuePath, "utf8")) as Record<string, unknown>
      expect("deleteSource" in persisted).toBe(false)
      expect(JSON.stringify(persisted)).not.toContain("deleteSource")

      await first.app.close()

      // ---- 第二次启动：恢复输入与任务行，状态为「待扫描」 ----
      const second = await launchElectronApp(userDataDir)
      await expect(second.page.locator('[data-testid="task-row"]')).toHaveCount(2, {
        timeout: 20000,
      })
      const tags = second.page.locator('[data-testid="task-status"]')
      await expect(tags.nth(0)).toHaveText("待扫描")
      await expect(tags.nth(1)).toHaveText("待扫描")
      // 顶栏状态也是「待扫描」——证明恢复后未自动开始（否则是「转码中」）
      await expect(second.page.locator('[data-testid="state-tag"]')).toContainText("待扫描")
      await second.app.close()
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test("上/下移调整执行顺序，并持久化到队列", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "mediac-e2e-"))
    const queuePath = path.join(userDataDir, "queue.json")

    try {
      const { app, page } = await launchElectronApp(userDataDir)
      await addInputs(page, [VIDEO_A, VIDEO_B])
      // 先等队列落盘：其广播先于防抖落盘发出，故文件存在即说明渲染层已拿到
      // path→queueId 镜像，此时点上下移才会真正调 reorder 落库而非本地降级重排。
      await expect.poll(() => readQueueNames(queuePath), { timeout: 8000 }).not.toBeNull()

      const firstRow = page.locator('[data-testid="task-row"]').first()
      await expect(firstRow.locator('[data-testid="btn-move-down"]')).toBeEnabled()
      await firstRow.locator('[data-testid="btn-move-down"]').click()

      await expect
        .poll(() => readQueueNames(queuePath), { timeout: 8000 })
        .toEqual([path.basename(VIDEO_B), path.basename(VIDEO_A)])

      await app.close()
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test("schemaVersion 未知时安全降级：队列为空且写 .bak 备份", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "mediac-e2e-"))
    const queuePath = path.join(userDataDir, "queue.json")

    try {
      await writeFile(
        queuePath,
        JSON.stringify({
          schemaVersion: 999,
          items: [
            { id: "q_x", path: VIDEO_A, name: path.basename(VIDEO_A), size: 1, status: "queued" },
          ],
        }),
        "utf8",
      )

      const { app, page } = await launchElectronApp(userDataDir)
      await expect(page.locator('[data-testid="app-container"]')).toBeVisible()
      // 未知版本不猜语义 → 空队列，绝不误跑
      await expect(page.locator('[data-testid="task-row"]')).toHaveCount(0)
      await expect
        .poll(async () => {
          try {
            await stat(`${queuePath}.bak`)
            return true
          } catch {
            return false
          }
        }, { timeout: 8000 })
        .toBe(true)

      await app.close()
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test("上次运行中被中断的项，重启后降级为 interrupted 且不自动重跑", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "mediac-e2e-"))
    const queuePath = path.join(userDataDir, "queue.json")

    try {
      await writeFile(
        queuePath,
        JSON.stringify({
          schemaVersion: 1,
          items: [
            {
              id: "q_a",
              path: VIDEO_A,
              name: path.basename(VIDEO_A),
              size: 100,
              srcMtimeMs: null,
              status: "running",
              error: null,
              fileDst: null,
              enqueuedAt: Date.now(),
            },
          ],
        }),
        "utf8",
      )

      const { app, page } = await launchElectronApp(userDataDir)
      await expect
        .poll(
          async () => {
            try {
              const raw = JSON.parse(await readFile(queuePath, "utf8")) as {
                items?: Array<{ status?: string }>
              }
              return raw.items?.[0]?.status ?? null
            } catch {
              return null
            }
          },
          { timeout: 8000 },
        )
        .toBe("interrupted")

      // 恢复为「待扫描」，绝不自动开始
      await expect(page.locator('[data-testid="task-row"]')).toHaveCount(1, { timeout: 20000 })
      await expect(page.locator('[data-testid="task-status"]').first()).toHaveText("待扫描")

      await app.close()
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})