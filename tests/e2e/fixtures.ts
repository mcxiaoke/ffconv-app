import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const appRoot = path.resolve(__dirname, "../../")

/**
 * 启动应用并返回首个窗口。
 *
 * ⚠️ 必须显式传入 `--user-data-dir`（每个用例一份独立目录）：
 * 应用会把预设/调参/高级选项/输出设置持久化到 `userData/settings.json`，
 * 若共用真实的 userData，一个用例改过的输出目录会被下一个用例继承
 * （03-workflow 会把输出模式改成「全部输出到同一文件夹」并指向 tests/temp，
 * 于是 02-interaction 扫描时拿到不存在的目录、开始按钮被禁用）。
 * 同时也避免 e2e 改写开发机上的真实配置。
 */
export async function launchElectronApp(
  userDataDir: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  let app: ElectronApplication
  try {
    app = await electron.launch({
      cwd: appRoot,
      args: [".", `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: "production",
      },
    })
  } catch (err) {
    // 单实例锁失败时 Electron 会立刻退出，Playwright 只报一句含糊的
    // "Process failed to launch!"。把原因翻译成可执行的提示。
    throw new Error(
      "无法启动 Electron。最常见原因是已有另一个应用实例在运行——" +
        "单实例锁会让新实例立刻退出（表现为 Process failed to launch / Error launching app 弹窗）。" +
        "请先关闭正在运行的 mediac 窗口或 `npm run dev`，再重跑 e2e。",
      { cause: err },
    )
  }
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  return { app, page }
}

export const test = base.extend<{
  userDataDir: string
  electronApp: ElectronApplication
  appWindow: Page
}>({
  // 每个用例一份独立 userData，用例结束后删除（见 launchElectronApp 的说明）。
  // Playwright 要求 fixture 函数首参必须是对象解构模式（否则抛
  // "First argument must use the object destructuring pattern"），
  // 而此 fixture 不依赖其它 fixture，故只能是空模式。
  // eslint-disable-next-line no-empty-pattern
  userDataDir: async ({}, use) => {
    const dir = await mkdtemp(path.join(tmpdir(), "mediac-e2e-"))
    await use(dir)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  },
  electronApp: async ({ userDataDir }, use) => {
    const { app } = await launchElectronApp(userDataDir)
    await use(app)
    await app.close()
  },
  appWindow: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await use(page)
  },
})

export { expect }
