import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import { appRoot, expect } from "../fixtures"

/**
 * 任务表性能压测（P1-8 第二步的性能评估 harness）。
 *
 * 按需运行，不进常规 e2e 门禁：
 *
 *   pwsh:  $env:FFCONV_PERF = "1"; npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/specs/08-perf.spec.ts
 *   可选:  $env:FFCONV_PERF_N = "500"   # 任务数，默认 1000
 *
 * 造数据方式：把 data/videos 下的测试视频**硬链接** N 份到临时目录（同卷零拷贝、
 * 路径唯一，不触碰生产代码的去重逻辑），一次「手动添加目录」即可注入全部任务。
 *
 * 指标（写入 tests/temp/perf-report-<ts>.json 并以 PERF: 前缀打到 stdout）：
 * - planMs        —— btn-plan 点击到 N 行全部出现的耗时（含 1000 次 ffprobe）
 * - restFps       —— 计划完成后静置 3s 的 rAF 帧率（基线）
 * - runFps        —— 转码进行中 15s 的 rAF 帧率（进度事件 10Hz 压力下）
 * - longTasks     —— 两个窗口内 >50ms 的主线程阻塞次数与最大时长
 * - clickLatency  —— 转码进行中每 3s 真实点击一次「按大小排序」，
 *                    测 click → 双 rAF（DOM 已提交渲染）的延迟
 *
 * 判读参考（评估是否需要渲染窗口）：runFps ≥ 30 且 longTaskMax < 200ms
 * → 无需窗口化；反之按此数据定位后再决定。
 */

const PERF_ENABLED = !!process.env.FFCONV_PERF
const TASK_COUNT = Number.parseInt(process.env.FFCONV_PERF_N || "1000", 10)
const SAMPLE_SRC_DIR = path.join(appRoot, "data", "videos")

test.skip(!PERF_ENABLED, "性能压测按需运行：设置 FFCONV_PERF=1 启用")

interface MeasureResult {
  frames: number
  durationMs: number
  longTasks: number[]
  clickLatencies: number[]
}

/** 在页面主线程里跑一个测量窗口：rAF 计帧 + longtask 观测 + 可选交互延迟探针 */
async function measureWindow(
  page: Page,
  durationMs: number,
  interaction = false,
): Promise<MeasureResult> {
  return page.evaluate(
    ({ durationMs, interaction }) =>
      new Promise<MeasureResult>((resolve) => {
        const longTasks: number[] = []
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration)
        })
        try {
          observer.observe({ entryTypes: ["longtask"] })
        } catch {
          /* longtask 不可用时静默跳过 */
        }

        const clickLatencies: number[] = []
        let frames = 0
        let probeTimer: ReturnType<typeof setInterval> | null = null

        const finish = () => {
          if (probeTimer) clearInterval(probeTimer)
          observer.disconnect()
          resolve({ frames, durationMs, longTasks, clickLatencies })
        }

        const start = performance.now()
        const tick = () => {
          frames++
          if (performance.now() - start >= durationMs) {
            finish()
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)

        if (interaction) {
          // 真实 DOM click + 双 rAF：第二次 rAF 回调意味着点击引起的渲染已提交
          probeTimer = setInterval(() => {
            const btn = document.querySelector<HTMLElement>('[data-testid="sort-size"]')
            if (!btn) return
            const t0 = performance.now()
            btn.click()
            requestAnimationFrame(() =>
              requestAnimationFrame(() => clickLatencies.push(performance.now() - t0)),
            )
          }, 3000)
        }
      }),
    { durationMs, interaction },
  )
}

function summarize(label: string, result: MeasureResult) {
  const fps = Math.round((result.frames / (result.durationMs / 1000)) * 10) / 10
  const longOver200 = result.longTasks.filter((d) => d > 200)
  return {
    label,
    fps,
    longTaskCount: result.longTasks.length,
    longTaskMaxMs: result.longTasks.length ? Math.round(Math.max(...result.longTasks)) : 0,
    longTaskOver200: longOver200.length,
    clickLatencies: result.clickLatencies.map((d) => Math.round(d)),
  }
}

test("任务表性能压测：规划耗时 / 静置与转码期帧率 / 交互延迟", async () => {
  test.setTimeout(600_000)

  const perfDir = await fs.mkdtemp(path.join(os.tmpdir(), "ffconv-perf-src-"))
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ffconv-perf-ud-"))
  let app: ElectronApplication | null = null

  try {
    // ---- 1) 硬链接造数据：N 个路径唯一的真实 mp4（同卷零拷贝） ----
    const sources = (await fs.readdir(SAMPLE_SRC_DIR))
      .filter((f) => f.toLowerCase().endsWith(".mp4"))
      .map((f) => path.join(SAMPLE_SRC_DIR, f))
    expect(sources.length, "data/videos 下缺少测试素材，请先补齐 e2e 视频").toBeGreaterThan(0)
    for (let i = 0; i < TASK_COUNT; i++) {
      const src = sources[i % sources.length]
      await fs.link(src, path.join(perfDir, `clip_${String(i).padStart(4, "0")}.mp4`))
    }

    // ---- 2) 启动应用（关闭后台节流，保证 rAF 测量不被 OccludedWindow 干扰） ----
    app = await electron.launch({
      cwd: appRoot,
      args: [
        ".",
        `--user-data-dir=${userDataDir}`,
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
      env: { ...process.env, NODE_ENV: "production" },
    })
    const page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")

    // ---- 3) 一次目录注入全部任务 ----
    await page.locator('[data-testid="input-manual-path"]').fill(perfDir)
    await page.locator('[data-testid="btn-manual-add"]').click()
    await expect(page.locator('[data-testid="chip-list"]')).toBeVisible({ timeout: 20000 })

    // ---- 4) 规划：btn-plan 到 N 行全部渲染 ----
    // 1000 个文件的 ffprobe 探测本身就要数十秒，表格要等规划完成才出现，
    // 因此直接以「N 行全部出现」为等待目标，不单独断言表格可见。
    const planStart = Date.now()
    await page.locator('[data-testid="btn-plan"]').click()
    await expect(page.locator('[data-testid="task-row"]')).toHaveCount(TASK_COUNT, {
      timeout: 300000,
    })
    const planMs = Date.now() - planStart

    // ---- 5) 静置基线（3s，无进度事件） ----
    const rest = summarize("rest", await measureWindow(page, 3000))

    // ---- 6) 开始转码，等真正进入 RUNNING ----
    await page.locator('[data-testid="btn-start"]').click()
    await expect(page.locator('[data-testid="state-tag"]')).toContainText("转码中", {
      timeout: 30000,
    })

    // P2-32 收口：转码中结构性操作必须呈**禁用态**，而不是可点但静默无效
    await expect(page.locator('[data-testid="btn-remove-task"]').first()).toBeDisabled()
    await expect(page.locator('[data-testid="btn-plan"]')).toBeDisabled()
    await expect(page.locator('[data-testid="btn-clear"]')).toBeDisabled()

    // ---- 7) 转码期测量（15s，含每 3s 一次排序点击延迟探针） ----
    const run = summarize("running", await measureWindow(page, 15000, true))

    // ---- 8) 停止，等离开 RUNNING/STOPPING ----
    await page.locator('[data-testid="btn-stop"]').click()
    await expect(page.locator('[data-testid="state-tag"]')).not.toContainText(/转码中|停止中/, {
      timeout: 60000,
    })

    // ---- 9) 报告 ----
    const report = {
      timestamp: new Date().toISOString(),
      taskCount: TASK_COUNT,
      planMs,
      rest,
      running: run,
    }
    const reportDir = path.join(appRoot, "temp")
    await fs.mkdir(reportDir, { recursive: true })
    const reportFile = path.join(reportDir, `perf-report-${Date.now()}.json`)
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2), "utf8")

    console.log(`PERF: taskCount=${TASK_COUNT} planMs=${planMs}`)
    console.log(
      `PERF: rest  fps=${rest.fps} longTasks=${rest.longTaskCount} longTaskMaxMs=${rest.longTaskMaxMs}`,
    )
    console.log(
      `PERF: run   fps=${run.fps} longTasks=${run.longTaskCount} longTaskMaxMs=${run.longTaskMaxMs} ` +
        `clickLatencies=${run.clickLatencies.join(",") || "n/a"}ms`,
    )
    console.log(`PERF: report written to ${reportFile}`)

    await app.close()
    app = null
  } finally {
    if (app) await app.close().catch(() => undefined)
    await fs.rm(perfDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }
})
