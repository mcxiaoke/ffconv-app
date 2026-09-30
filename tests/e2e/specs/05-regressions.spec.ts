import { test, expect } from "../fixtures"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VIDEO_A = path.resolve(__dirname, "../../../data/videos/TEST2__h264_60fps_1080.mp4")
const VIDEO_B = path.resolve(__dirname, "../../../data/videos/TEST2__hevc_60fps_1080.mp4")

/** 两个测试素材的真实时长均为 4.3 秒（ffprobe 实测），应显示为 00:04 */
const EXPECTED_DURATION = "00:04"

async function stageTwo(page: import("@playwright/test").Page) {
  for (const p of [VIDEO_A, VIDEO_B]) {
    await page.locator('[data-testid="input-manual-path"]').fill(p)
    await page.locator('[data-testid="btn-manual-add"]').click()
  }
  await expect(page.locator('[data-testid="task-row"]')).toHaveCount(2, { timeout: 20000 })
  await page.locator('[data-testid="btn-plan"]').click()
  await expect(page.locator('[data-testid="state-tag"]')).toContainText(/就绪/, { timeout: 30000 })
}

test.describe("Regressions - task duration projection", () => {
  test("时长列与详情卡显示真实时长，而非 00:00", async ({ appWindow }) => {
    await stageTwo(appWindow)

    // 公开任务快照曾只读顶层 duration，而计划阶段的时长在 dstArgs.srcDuration，
    // 导致表格「时长」列恒为 00:00（同屏日志却写着正确的预估耗时）。
    const cells = await appWindow.locator('[data-testid="task-row"] td:nth-child(5)').allTextContents()
    expect(cells.map((c) => c.trim())).toEqual([EXPECTED_DURATION, EXPECTED_DURATION])

    // 检查器详情卡同样使用该字段
    await appWindow.locator('[data-testid="task-row"]').first().dblclick()
    const drawer = appWindow.locator(".inspector-drawer")
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText(EXPECTED_DURATION)
    await expect(drawer).toContainText("1920×1080")
    // 缺项不得渲染成 undefined
    await expect(drawer).not.toContainText("undefined")
  })
})

test.describe("Regressions - input removal stays in sync", () => {
  test("移除输入 chip 会同时移除任务行与主进程暂存项", async ({ appWindow }) => {
    await stageTwo(appWindow)

    const chips = appWindow.locator('[data-testid="chip-list"] .chip')
    await expect(chips).toHaveCount(2)

    // 此前 removeInput 只改 configStore：chip 2->1，但表格仍是 2 行、
    // 顶栏仍显示「开始转码 · 2」，被删掉的文件照样被转码。
    await chips.first().locator("button, .chip-x").first().click()

    await expect(chips).toHaveCount(1)
    await expect(appWindow.locator('[data-testid="task-row"]')).toHaveCount(1)

    // 被移除的是第一个 chip（h264），剩下的应是第二个（hevc）
    const remaining = await appWindow.locator('[data-testid="task-row"]').first().textContent()
    expect(remaining).toContain("TEST2__hevc_60fps_1080")
    expect(remaining).not.toContain("TEST2__h264_60fps_1080")
  })
})

test.describe("Regressions - narrow layout", () => {
  test("最小窗口宽度下表格各列不被压成 0", async ({ electronApp, appWindow }) => {
    await stageTwo(appWindow)

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(960, 640)
    })
    await appWindow.waitForTimeout(800)

    // 表格用 table-layout:fixed + 百分比列，固定列合计 628px。
    // 窗口 960px 且侧栏展开时主区仅 561px，两个百分比列曾被压到 0px
    // （源文件/目标文件整列不可见）。窄窗口应自动折叠侧栏。
    const widths = await appWindow.evaluate(() => {
      const sc = document.querySelector(".table-body-scroll")
      if (!sc) return null
      return {
        overflowX: sc.scrollWidth - sc.clientWidth,
        cols: [...document.querySelectorAll("table.tasks thead th")].map(
          (th) => Math.round(th.getBoundingClientRect().width),
        ),
      }
    })
    expect(widths).not.toBeNull()
    expect(widths!.overflowX).toBeLessThanOrEqual(1)
    // 复选框 / # / 源文件 / 大小 / 时长 / 解码→编码 / 目标文件 / 状态 / 操作
    for (const w of widths!.cols) {
      expect(w).toBeGreaterThan(10)
    }
  })
})
