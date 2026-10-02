import { type Page } from "@playwright/test"
import { test, expect, launchElectronApp } from "../fixtures"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VIDEO_A = path.resolve(__dirname, "../../../data/videos/TEST2__h264_60fps_1080.mp4")
const VIDEO_B = path.resolve(__dirname, "../../../data/videos/TEST2__hevc_60fps_1080.mp4")

/** 添加两个素材并生成计划（与 05-regressions 同一套流程） */
async function stageTwo(page: Page): Promise<void> {
  for (const p of [VIDEO_A, VIDEO_B]) {
    await page.locator('[data-testid="input-manual-path"]').fill(p)
    await page.locator('[data-testid="btn-manual-add"]').click()
  }
  await expect(page.locator('[data-testid="task-row"]')).toHaveCount(2, { timeout: 20000 })
  await page.locator('[data-testid="btn-plan"]').click()
  await expect(page.locator('[data-testid="state-tag"]')).toContainText(/就绪/, { timeout: 30000 })
}

test.describe("Phase1 - settings persistence", () => {
  test("重启后恢复预设/调参/高级选项，且不继承「转码后删除源文件」", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "mediac-e2e-"))
    const settingsPath = path.join(userDataDir, "settings.json")

    try {
      // ---- 第一次启动：改设置 ----
      const first = await launchElectronApp(userDataDir)
      const presetSelect = first.page.locator('[data-testid="select-preset"]')
      await expect(presetSelect).toBeVisible({ timeout: 20000 })
      // 预设列表来自主进程异步探测（fetchEnv），select 先可见、选项后到齐，
      // 直接读会拿到 0 个 option——必须先等选项填充。
      await expect
        .poll(() => presetSelect.locator("option").count(), { timeout: 25000 })
        .toBeGreaterThan(1)
      const optionValues = await presetSelect
        .locator("option")
        .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value))
      expect(optionValues.length).toBeGreaterThan(1)
      const chosenPreset = optionValues[1]
      await presetSelect.selectOption(chosenPreset)

      // 视频质量 CRF（视频手风琴默认收起，先展开）
      await first.page.locator('[data-testid="card-video"] .card-title').click()
      await expect(first.page.locator('[data-testid="video-body"]')).toBeVisible()
      await first.page.locator('[data-testid="input-quality"]').fill("31")
      await first.page.locator('[data-testid="input-quality"]').blur()

      // 高级：并发 3 + 打开「转码后删除源文件」
      await first.page.locator('[data-testid="btn-open-settings"]').click()
      await expect(first.page.locator('[data-testid="settings-modal"]')).toBeVisible()
      await first.page.locator('[data-testid="input-jobs"]').fill("3")
      await first.page.locator('[data-testid="sw-delete-source"]').click()
      await expect(first.page.locator('[data-testid="sw-delete-source"]')).toHaveAttribute(
        "aria-checked",
        "true",
      )
      await first.page.keyboard.press("Escape")
      await expect(first.page.locator('[data-testid="settings-modal"]')).toBeHidden()

      // 回写是 400ms 防抖，等到三项变更都落到同一个文件
      await expect
        .poll(
          async () => {
            try {
              const raw = JSON.parse(await readFile(settingsPath, "utf8")) as {
                preset?: string
                tune?: { quality?: number }
                adv?: { jobs?: number; deleteSource?: unknown }
              }
              return { preset: raw.preset, quality: raw.tune?.quality, jobs: raw.adv?.jobs }
            } catch {
              return null
            }
          },
          { timeout: 8000 },
        )
        .toEqual({ preset: chosenPreset, quality: 31, jobs: 3 })

      const persisted = JSON.parse(await readFile(settingsPath, "utf8")) as {
        adv: Record<string, unknown>
      }
      // 高危开关不得进入持久化形状
      expect("deleteSource" in persisted.adv).toBe(false)

      await first.app.close()

      // ---- 第二次启动：设置应被还原 ----
      const second = await launchElectronApp(userDataDir)
      const secondPreset = second.page.locator('[data-testid="select-preset"]')
      await expect(secondPreset).toBeVisible({ timeout: 20000 })
      await expect.poll(() => secondPreset.inputValue(), { timeout: 15000 }).toBe(chosenPreset)

      await second.page.locator('[data-testid="card-video"] .card-title').click()
      await expect(second.page.locator('[data-testid="input-quality"]')).toHaveValue("31")

      await second.page.locator('[data-testid="btn-open-settings"]').click()
      await expect(second.page.locator('[data-testid="settings-modal"]')).toBeVisible()
      await expect(second.page.locator('[data-testid="input-jobs"]')).toHaveValue("3")
      // 删源每次启动都必须是显式关闭状态
      await expect(second.page.locator('[data-testid="sw-delete-source"]')).toHaveAttribute(
        "aria-checked",
        "false",
      )

      await second.app.close()
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})

test.describe("Phase1 - 错误提示不再使用原生 alert", () => {
  test("未添加输入点「扫描」出现应用内 toast，且未调用 window.alert", async ({ appWindow }) => {
    // 记录原生 alert 调用；toast 之前这里是 alert("请先添加至少一个媒体文件或目录")
    await appWindow.evaluate(() => {
      const w = window as unknown as { __alerts: string[]; alert: (m?: unknown) => void }
      w.__alerts = []
      w.alert = (m?: unknown) => {
        w.__alerts.push(String(m))
      }
    })

    await appWindow.locator('[data-testid="btn-plan"]').click()

    const toast = appWindow.locator('[data-testid="toast"]')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText("请先添加至少一个媒体文件或目录")

    const alerts = await appWindow.evaluate(
      () => (window as unknown as { __alerts: string[] }).__alerts,
    )
    expect(alerts).toEqual([])
  })
})

test.describe("Phase1 - 任务表搜索 / 状态筛选 / 排序", () => {
  test("搜索、状态筛选与按大小排序只影响展示", async ({ appWindow }) => {
    await stageTwo(appWindow)

    const rows = appWindow.locator('[data-testid="task-row"]')
    await expect(rows).toHaveCount(2)

    // 计划阶段会按源/目标是否一致决定「等待中」或「已跳过」，
    // 因此期望条数从实际状态推导，而不是硬编码（换素材/预设也不会误报）。
    const statusTexts = await rows.locator('[data-testid="task-status"]').allTextContents()
    const countOf = (label: string) => statusTexts.filter((t) => t.includes(label)).length

    // 搜索：只留 h264 那个。用**完整源文件名**而非 "hevc"/"h264" 短词——
    // 表格对源名/路径/目标名一并检索，而默认预设名（如 hevc_2k）会出现在
    // 目标文件名里，用短词会把另一行也命中。
    await appWindow.locator('[data-testid="input-task-search"]').fill("TEST2__h264_60fps_1080.mp4")
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText("TEST2__h264_60fps_1080")
    await expect(appWindow.locator('[data-testid="task-filter-count"]')).toHaveText("1 / 2")

    await appWindow.locator('[data-testid="input-task-search"]').fill("")
    await expect(rows).toHaveCount(2)

    // 状态筛选
    await appWindow.locator('[data-testid="select-status-filter"]').selectOption("pending")
    await expect(rows).toHaveCount(countOf("等待中"))

    await appWindow.locator('[data-testid="select-status-filter"]').selectOption("skipped")
    await expect(rows).toHaveCount(countOf("已跳过"))

    await appWindow.locator('[data-testid="select-status-filter"]').selectOption("success")
    await expect(rows).toHaveCount(0)
    await expect(appWindow.locator('[data-testid="no-match-row"]')).toBeVisible()

    await appWindow.locator('[data-testid="select-status-filter"]').selectOption("all")
    await expect(rows).toHaveCount(2)

    // 排序：首次点击按大小降序，最大的排第一
    const [sizeA, sizeB] = await Promise.all([stat(VIDEO_A), stat(VIDEO_B)])
    const larger = sizeA.size >= sizeB.size ? "TEST2__h264_60fps_1080" : "TEST2__hevc_60fps_1080"
    const smaller = sizeA.size >= sizeB.size ? "TEST2__hevc_60fps_1080" : "TEST2__h264_60fps_1080"

    await appWindow.locator('[data-testid="sort-size"]').click()
    await expect(rows.first()).toContainText(larger)

    // 再次点击切换为升序
    await appWindow.locator('[data-testid="sort-size"]').click()
    await expect(rows.first()).toContainText(smaller)

    // 清空筛选按钮在筛选态下才出现
    await appWindow.locator('[data-testid="input-task-search"]').fill("never-match")
    await expect(appWindow.locator('[data-testid="no-match-row"]')).toBeVisible()
    await appWindow.locator('[data-testid="btn-clear-filter"]').click()
    await expect(rows).toHaveCount(2)
  })
})

test.describe("Phase1 - 模态焦点陷阱", () => {
  test("设置弹窗内 Tab 循环、关闭后焦点归位", async ({ appWindow }) => {
    const openBtn = appWindow.locator('[data-testid="btn-open-settings"]')
    await openBtn.click()
    const modal = appWindow.locator('[data-testid="settings-modal"]')
    await expect(modal).toBeVisible()

    const isFocusInsideModal = () =>
      appWindow.evaluate(() => {
        const m = document.querySelector('[data-testid="settings-modal"]')
        return m !== null && m.contains(document.activeElement)
      })

    // 打开即把焦点移入弹窗
    await expect.poll(isFocusInsideModal, { timeout: 5000 }).toBe(true)

    // 连续 Tab / Shift+Tab 都不得逃到被遮罩的背景控件
    for (let i = 0; i < 12; i++) {
      await appWindow.keyboard.press("Tab")
      expect(await isFocusInsideModal()).toBe(true)
    }
    for (let i = 0; i < 5; i++) {
      await appWindow.keyboard.press("Shift+Tab")
      expect(await isFocusInsideModal()).toBe(true)
    }

    // 关闭后焦点回到触发按钮
    await appWindow.keyboard.press("Escape")
    await expect(modal).toBeHidden()
    await expect(openBtn).toBeFocused()
  })
})

test.describe("Phase1 - 「文件与输出」分组重置", () => {
  test("通用参数一键恢复默认，且不会清掉已添加的素材", async ({ appWindow }) => {
    const resetLink = appWindow.locator('[data-testid="btn-reset-output"]')
    // 默认态无脏值：不显示重置入口（与视频/音频卡一致）
    await expect(resetLink).toBeHidden()

    // 先加一个素材：重置只该动参数，不该动用户挑的文件
    await appWindow.locator('[data-testid="input-manual-path"]').fill(VIDEO_A)
    await appWindow.locator('[data-testid="btn-manual-add"]').click()
    await expect(appWindow.locator('[data-testid="chip-list"] .chip')).toHaveCount(1, {
      timeout: 20000,
    })

    // 把四个通用参数都改脏
    await appWindow.locator('[data-testid="input-output-dir"]').fill("C:/tmp/mediac-out")
    await appWindow.locator('[data-testid="select-output-mode"]').selectOption("file")
    await appWindow.locator('[data-testid="input-prefix"]').fill("pre_")
    await appWindow.locator('[data-testid="input-suffix"]').fill("_suf")

    await expect(resetLink).toBeVisible()
    await expect(resetLink).toHaveText("重置 (4)")

    await resetLink.click()

    await expect(appWindow.locator('[data-testid="input-output-dir"]')).toHaveValue("")
    await expect(appWindow.locator('[data-testid="select-output-mode"]')).toHaveValue("dir")
    await expect(appWindow.locator('[data-testid="input-prefix"]')).toHaveValue("")
    await expect(appWindow.locator('[data-testid="input-suffix"]')).toHaveValue("")
    await expect(resetLink).toBeHidden()
    // 素材必须还在
    await expect(appWindow.locator('[data-testid="chip-list"] .chip')).toHaveCount(1)
  })
})

test.describe("Phase1 - 预设加载不阻塞在硬件探测", () => {
  test("轻量预设通道显著快于完整环境摘要", async ({ appWindow }) => {
    const result = await appWindow.evaluate(async () => {
      const api = (
        window as unknown as {
          api: { getPresetCatalog: () => Promise<{ presets: unknown[] }> }
        }
      ).api
      const started = performance.now()
      const catalog = await api.getPresetCatalog()
      return { ms: performance.now() - started, count: catalog.presets.length }
    })

    expect(result.count).toBeGreaterThan(1)
    // 硬件探测（ffmpeg -version + 枚举数百编码器 + 按 GPU 矩阵逐项探测）实测约 2s，
    // 而预设通道只读 YAML（实测约 15ms）。若有人把硬件探测重新塞回这条路径，
    // 左侧面板又会卡住 1~2s，这里会失败。
    expect(result.ms).toBeLessThan(1000)
  })
})

test.describe("Phase1 - 日志面板跟随主题", () => {
  test("浅色主题下日志区不再是固定的深色背景", async ({ appWindow }) => {
    await appWindow.locator('[data-testid="btn-open-log"]').click()
    await expect(appWindow.locator('[data-testid="log-drawer"]')).toBeVisible()

    const bgFor = (theme: string) =>
      appWindow.evaluate((t) => {
        document.documentElement.setAttribute("data-theme", t)
        const el = document.querySelector(".log-body")
        return el ? getComputedStyle(el).backgroundColor : null
      }, theme)

    const light = await bgFor("light")
    const dark = await bgFor("dark")

    expect(light).not.toBeNull()
    expect(dark).not.toBeNull()
    // 两套主题必须给出不同背景
    expect(light).not.toBe(dark)
    // 浅色主题下不得仍是旧实现里写死的 #0d1117
    expect(light).not.toBe("rgb(13, 17, 23)")
  })
})

test.describe("Phase1 - 引擎日志进入运行日志面板", () => {
  test("环境探测（hwdetect）的初始化日志经日志汇聚出现在面板", async ({ appWindow }) => {
    // 日志面板无需预先打开：logStore 在收到事件时即写入缓冲区
    await appWindow.locator('[data-testid="btn-open-log"]').click()
    const logDrawer = appWindow.locator('[data-testid="log-drawer"]')
    await expect(logDrawer).toBeVisible()

    // hwdetect 的环境摘要（ffmpeg 构建 / 编码器 / 硬件加速栈 / GPU）此前只写主进程
    // console 与临时文件，从不进面板；这里断言它已被转发。
    await expect(logDrawer).toContainText("[hwdetect]", { timeout: 30000 })
  })
})

test.describe("Phase1 - 日志级别与导出", () => {
  test("设置面板提供日志级别选择器，默认 info", async ({ appWindow }) => {
    await appWindow.locator('[data-testid="btn-open-settings"]').click()
    const levelSelect = appWindow.locator('[data-testid="select-log-level"]')
    await expect(levelSelect).toBeVisible()
    await expect(levelSelect).toHaveValue("info")
    // 弹窗无 Esc 处理，点遮罩空白处关闭
    await appWindow.locator('[data-testid="settings-modal-mask"]').click({ position: { x: 5, y: 5 } })
    await expect(appWindow.locator('[data-testid="settings-modal"]')).not.toBeVisible()
  })

  test("日志抽屉可把日志保存到文件（主进程落盘并回传路径）", async ({ appWindow }) => {
    await appWindow.locator('[data-testid="btn-open-log"]').click()
    await expect(appWindow.locator('[data-testid="log-drawer"]')).toBeVisible()

    await appWindow.locator('[data-testid="btn-save-log"]').click()
    // 主进程写文件成功后给出 toast（含落盘路径），失败会提示失败
    await expect(appWindow.locator('[data-testid="toast-host"]')).toContainText("日志已保存", {
      timeout: 20000,
    })
  })
})
