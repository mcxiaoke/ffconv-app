import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from "electron"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { transcodeService } from "./ffmpeg-service.js"
import { toSerializable } from "./ipc-serializer.js"
import { openPath, showItemInFolder, showNotification, writeClipboardText } from "./native.js"
import { SettingsStore } from "./settings-store.js"
import { IPC_CHANNELS, MENU_ACTIONS, MENU_ACTION_CHANNEL } from "../shared/ipc-channels.js"

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

// Windows 上必须设置 AppUserModelID，否则 Notification 走「无名」身份，
// Windows 通知中心不显示/不关联到本应用（转码完成通知会静默不弹）。
// 需在 app ready 之前设置。
if (process.platform === "win32") {
  try {
    app.setAppUserModelId("com.mediac.desktop")
  } catch {
    // 旧版本 Electron 可能不支持；忽略即可
  }
}

function summaryFfmpegPath() {
  return transcodeService.getFfmpegPath()
}

/**
 * 设置存储延迟到首次使用时构造：`app.getPath("userData")` 在 ready 之前
 * 不保证反映最终的应用名，延迟构造可避免把设置写到错误的目录。
 */
let settingsStore: SettingsStore | null = null
function getSettingsStore(): SettingsStore {
  if (!settingsStore) {
    settingsStore = new SettingsStore(path.join(app.getPath("userData"), "settings.json"))
  }
  return settingsStore
}

/** 菜单动作统一出口：字串取自共享常量，避免与渲染进程拼写漂移 */
function sendMenuAction(window: BrowserWindow, action: (typeof MENU_ACTIONS)[keyof typeof MENU_ACTIONS]) {
  window.webContents.send(MENU_ACTION_CHANNEL, action)
}

/**
 * 转码执行中禁止 reload / forceReload。
 *
 * reload 会重建渲染层 store（任务表清空、状态回 IDLE），而主进程引擎仍在跑：
 * 后续 task.progress / task.done 事件因 taskId 找不到任务被静默丢弃，
 * 此时终止按钮也失效（stopExecution 守卫只认 RUNNING/STOPPING），
 * 会话结束时 session.summary 还会把空 store 置成 COMPLETED。
 * 宁可明确提示，也不让界面状态与实际执行脱钩。
 */
function guardReload(window: BrowserWindow): boolean {
  // 用 isBusy()（含 PLANNING）而非 isExecuting()：规划期间 reload 同样会让
  // 界面与主进程脱钩（计划会被丢弃），提示文案也需区分。
  if (!transcodeService.isBusy()) return true
  const planning = transcodeService.getStatus() === "PLANNING"
  dialog.showMessageBoxSync(window, {
    type: "warning",
    buttons: ["知道了"],
    defaultId: 0,
    cancelId: 0,
    title: "无法重新加载",
    message: planning ? "正在生成转码计划，无法重新加载界面。" : "转码任务正在进行中，无法重新加载界面。",
    detail: planning
      ? "重新加载会丢弃正在构建的计划。请稍候片刻再试。"
      : "重新加载会让界面与实际执行脱钩（进度丢失、无法终止）。请先「终止转码」或等待本批次完成。",
  })
  return false
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

function getAppIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "../../build/icon.ico"),
    path.join(__dirname, "../../resources/icon.ico"),
    path.join(process.resourcesPath, "icon.ico"),
    path.join(process.resourcesPath, "build/icon.ico"),
  ]
  return candidates.find((c) => existsSync(c))
}

function startupLog(message: string) {
  try {
    const logDir = app.getPath("logs")
    mkdirSync(logDir, { recursive: true })
    appendFileSync(path.join(logDir, "mediac-desktop-startup.log"), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Logging must never mask the original startup error.
  }
}

process.on("uncaughtException", (error) => {
  startupLog(`uncaughtException: ${error.stack || error}`)
  console.error(error)
})

process.on("unhandledRejection", (error) => {
  startupLog(`unhandledRejection: ${String(error)}`)
  console.error(error)
})

function isTrustedSender(event: IpcMainInvokeEvent) {
  const frameUrl = event.senderFrame?.url || event.sender.getURL()
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    try {
      return new URL(frameUrl).origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }
  const normalized = frameUrl.replace(/\\/g, "/").toLowerCase()
  return normalized.startsWith("file://") && normalized.includes("/out/renderer/")
}

/**
 * 注册仅接受可信来源的 IPC handler。
 *
 * handler 的参数类型刻意写成 `(...args: never[]) => unknown`：它只用于**约束注册侧**
 * （各 handler 自带更精确的入参类型，如 `(body: Record<string, unknown>) => ...`），
 * 调用侧拿到的却是 ipcMain 的 `any[]`，因此在调用点做一次显式断言。
 * 这样既不引入 `any` 注解，也不会把「渲染层传来的值已可信」这一假设写成类型事实。
 */
function handleTrusted(channel: string, handler: (...args: never[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error("Untrusted IPC sender")
    }
    return toSerializable(await (handler as (...a: unknown[]) => unknown)(...args))
  })
}

function setupApplicationMenu(window: BrowserWindow) {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "文件 (&F)",
      submenu: [
        {
          label: "添加媒体文件 (&O)...",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.ADD_FILES)
          },
        },
        {
          label: "添加媒体目录 (&D)...",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.ADD_DIRECTORY)
          },
        },
        { type: "separator" },
        {
          label: "打开输出目录 (&P)",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.OPEN_OUTPUT_DIR)
          },
        },
        {
          label: "打开日志目录",
          click: () => {
            const logDir = app.getPath("logs")
            void shell.openPath(logDir)
          },
        },
        { type: "separator" },
        {
          label: "退出 (&X)",
          accelerator: process.platform === "darwin" ? "Cmd+Q" : "Alt+F4",
          click: () => {
            app.quit()
          },
        },
      ],
    },
    {
      label: "任务 (&T)",
      submenu: [
        {
          label: "生成 / 更新计划",
          accelerator: "CmdOrCtrl+Enter",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.CREATE_PLAN)
          },
        },
        {
          label: "开始转码",
          accelerator: "F5",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.START_EXECUTION)
          },
        },
        {
          label: "试运行 (测前10帧)",
          accelerator: "CmdOrCtrl+F5",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.START_DRY_RUN)
          },
        },
        {
          label: "终止转码",
          accelerator: "Shift+F5",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.STOP_EXECUTION)
          },
        },
        { type: "separator" },
        {
          label: "清空任务清单",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.CLEAR_TASKS)
          },
        },
      ],
    },
    {
      label: "视图 (&V)",
      submenu: [
        {
          label: "收起 / 展开左侧配置栏",
          accelerator: "CmdOrCtrl+B",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.TOGGLE_SIDEBAR)
          },
        },
        {
          label: "运行日志面板",
          accelerator: "CmdOrCtrl+L",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.TOGGLE_LOG)
          },
        },
        {
          label: "切换界面主题 (暗黑 / 明亮)",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.TOGGLE_THEME)
          },
        },
        { type: "separator" },
        {
          // 不用 role: "reload"：role 无法拦截，运行中 reload 会让 UI 与引擎脱钩
          label: "重新加载 (&R)",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            if (guardReload(window)) window.webContents.reload()
          },
        },
        {
          label: "强制重新加载",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => {
            if (guardReload(window)) window.webContents.reloadIgnoringCache()
          },
        },
        { role: "toggleDevTools", label: "开发者工具 (&I)" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "帮助 (&H)",
      submenu: [
        {
          label: "偏好设置 (&S)...",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            sendMenuAction(window, MENU_ACTIONS.OPEN_SETTINGS)
          },
        },
        { type: "separator" },
        {
          // 原实现硬编码开发机 data/videos 路径，打包后必然失效且无声
          label: "打开应用数据目录",
          click: () => {
            void shell.openPath(app.getPath("userData"))
          },
        },
        {
          label: "关于 mediac FFmpeg Studio",
          click: () => {
            void dialog
              .showMessageBox(window, {
                type: "info",
                title: "关于 mediac FFmpeg Studio",
                message: "mediac FFmpeg Studio",
                detail: [
                  `版本 ${app.getVersion()}`,
                  `Electron ${process.versions.electron} / Node ${process.versions.node}`,
                  `ffmpeg: ${summaryFfmpegPath() || "未检测到"}`,
                  "批量音视频转码工作台 · 基于 mediac CLI 的 ffmpeg 核心",
                ].join("\n"),
                buttons: ["确定"],
                defaultId: 0,
              })
              .catch(() => undefined)
          },
        },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "mediac FFmpeg Studio · 批量音视频转码工作台",
    icon: getAppIconPath(),
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  setupApplicationMenu(mainWindow)

  mainWindow.on("close", (event) => {
    if (transcodeService.isExecuting()) {
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: "warning",
        buttons: ["取消", "强行退出"],
        defaultId: 0,
        cancelId: 0,
        title: "退出确认",
        message: "当前有转码任务正在进行中！",
        detail: "如果现在退出，转码将被强行中止，正在写入的文件可能损坏。确定要退出吗？",
      })
      if (choice === 0) {
        event.preventDefault()
      }
    }
  })

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    startupLog(`preload-error ${preloadPath}: ${error.stack || error}`)
  })
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    startupLog(`did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`)
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  transcodeService.setEventSink((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.EXECUTION_EVENT, toSerializable(event))
    }
  })
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"))
  }
}

app.on("second-instance", () => {
  // 首实例可能已经没有窗口（macOS 常见；Windows 上窗口被关但进程因单实例锁仍在），
  // 此时只 focus 什么都不会发生，第二个实例又直接退出，用户看不到任何东西。
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

/**
 * 「转码后删除源文件」的确认由**主进程**用原生对话框完成。
 *
 * 此前确认发生在渲染层（window.confirm），主进程只校验渲染层回传的一个布尔位，
 * 还额外接受 `options.autoConfirm` 作为旁路 —— 等于这道不可撤销操作的安全门
 * 由信任度最低的一方自行声明通过，渲染层一旦被攻破即可无交互删源。
 * 现在渲染层只表达意图，判定权与对话框都在主进程。
 */
transcodeService.setDeleteSourceConfirmer(async () => {
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["取消", "确认删除源文件"],
    defaultId: 0,
    cancelId: 0,
    title: "高危操作确认",
    message: "转码成功后将删除源文件",
    detail:
      "源文件会被移入 Mediac 安全回收目录（~/.mediac/deleted/日期），可随时恢复。\n" +
      "该操作不可撤销地影响原始素材，确定继续吗？",
    noLink: true,
  }
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
})

handleTrusted(IPC_CHANNELS.APP_GET_VERSION, () => app.getVersion())
handleTrusted(IPC_CHANNELS.ENV_GET, () => transcodeService.getSummary())
// 轻量通道：启动时先拿预设，不阻塞在硬件探测上（详见 FfmpegEnvironment.getPresetCatalog）
handleTrusted(IPC_CHANNELS.ENV_GET_PRESETS, () => transcodeService.getPresetCatalog())
handleTrusted(IPC_CHANNELS.ENV_SET_CUSTOM_PATHS, async (payload: unknown) => {
  if (!payload || typeof payload !== "object") throw new Error("Invalid tool paths payload")
  return transcodeService.setCustomToolPaths(payload as {
    ffmpeg?: string
    ffprobe?: string
    mediainfo?: string
  })
})
handleTrusted(IPC_CHANNELS.SETTINGS_GET, () => getSettingsStore().load())
handleTrusted(IPC_CHANNELS.SETTINGS_SET, (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("settings payload must be a plain object")
  }
  // 白名单校验与原子写都在 SettingsStore 内完成，渲染层传什么都无法写出未知字段
  return getSettingsStore().save(payload)
})
handleTrusted(IPC_CHANNELS.STAGE_INPUTS, async (paths: unknown) => {
  if (!Array.isArray(paths)) throw new Error("paths must be an array of strings")
  return transcodeService.stageInputs(paths as string[])
})
handleTrusted(IPC_CHANNELS.STAGE_CLEAR, async () => {
  return transcodeService.clearStagedInputs()
})
handleTrusted(IPC_CHANNELS.STAGE_REMOVE, async (paths: unknown) => {
  if (!Array.isArray(paths)) throw new Error("paths must be an array of strings")
  return transcodeService.removeStagedInputs(paths as string[])
})
handleTrusted(IPC_CHANNELS.PLAN_CREATE, (body: Record<string, unknown>) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("plan body must be a plain object")
  }
  return transcodeService.createPlan(body)
})
handleTrusted(IPC_CHANNELS.EXECUTION_START, async (taskIds: unknown, options?: unknown) => {
  if (taskIds !== undefined && (!Array.isArray(taskIds) || taskIds.some((id) => typeof id !== "string"))) {
    throw new Error("taskIds must be an array of strings")
  }
  const opts = options && typeof options === "object" ? (options as { dryRun?: boolean }) : undefined
  return transcodeService.startExecution(taskIds as string[] | undefined, opts)
})
handleTrusted(IPC_CHANNELS.EXECUTION_STOP, () => transcodeService.stopExecution())
handleTrusted(IPC_CHANNELS.EXECUTION_GET_STATUS, () => transcodeService.getExecutionSnapshot())
// S-1 加固：SYSTEM_OPEN_PATH / SYSTEM_SHOW_IN_FOLDER 仅接受主进程已知的路径
// （staged 输入、计划产物、原生对话框授权根），防止被攻破的渲染层打开任意路径
handleTrusted(IPC_CHANNELS.SYSTEM_SHOW_IN_FOLDER, async (fullPath: unknown) => {
  if (typeof fullPath !== "string") throw new Error("fullPath must be a string")
  if (!transcodeService.isKnownMediaPath(fullPath)) {
    throw new Error("Path is not recognized by the main process")
  }
  return showItemInFolder(fullPath)
})
handleTrusted(IPC_CHANNELS.SYSTEM_OPEN_PATH, async (fullPath: unknown) => {
  if (typeof fullPath !== "string") throw new Error("fullPath must be a string")
  if (!transcodeService.isKnownMediaPath(fullPath)) {
    throw new Error("Path is not recognized by the main process")
  }
  return openPath(fullPath)
})
// 剪贴板必须由主进程写入：沙箱 preload 的 require("electron") 不暴露 clipboard。
handleTrusted(IPC_CHANNELS.SYSTEM_COPY_TEXT, (text: unknown) => {
  if (typeof text !== "string") throw new Error("text must be a string")
  // 单条复制内容上限保护：ffmpeg 预览命令/整份日志可能很大
  if (text.length > 2_000_000) {
    return writeClipboardText(text.slice(0, 2_000_000))
  }
  return writeClipboardText(text)
})
handleTrusted(IPC_CHANNELS.SYSTEM_NOTIFY, async (payload: unknown) => {
  const p = payload as { title?: string; body?: string }
  if (!p || typeof p !== "object") throw new Error("Invalid notify payload")
  showNotification(p.title || "mediac", p.body || "", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
})
handleTrusted(
  IPC_CHANNELS.DIALOG_SELECT_FILES,
  async (options: { mode?: "file" | "directory"; multiple?: boolean }) => {
    if (!options || typeof options !== "object") {
      throw new Error("Invalid dialog options")
    }
    const mode = options.mode === "directory" ? "directory" : "file"
    const properties: Array<"openDirectory" | "openFile" | "multiSelections"> =
      mode === "directory"
        ? ["openDirectory"]
        : options.multiple === false
          ? ["openFile"]
          : ["openFile", "multiSelections"]
    const dialogOptions = { properties }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    const picked = result.canceled ? [] : result.filePaths
    // 用户亲手选择的路径即视为授权（S-1 白名单的授权来源，主进程侧登记）
    transcodeService.authorizePaths(picked)
    return { paths: picked }
  },
)

app.whenReady()
  .then(async () => {
    startupLog("app ready")
    await transcodeService.initialize()
    createWindow()
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    // 同步权限检查走的是另一个 handler：navigator.permissions.query /
    // Notification.requestPermission 的 check 路径不被上面的 request handler 覆盖，
    // 不设它渲染层仍可探测权限状态。
    session.defaultSession.setPermissionCheckHandler(() => false)
  })
  .catch((error) => {
    startupLog(`app ready error: ${error.stack || error}`)
    console.error(error)
  })

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on("before-quit", () => {
  try {
    transcodeService.dispose()
  } catch (error) {
    startupLog(`dispose error: ${error instanceof Error ? error.stack : String(error)}`)
  }
})
