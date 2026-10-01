import { contextBridge, ipcRenderer, webUtils } from "electron"
import { IPC_CHANNELS, MENU_ACTION_CHANNEL } from "../shared/ipc-channels.js"
import type { DesktopApi, EngineEvent } from "../shared/contracts.js"

function safeClone<T>(val: T): T {
  if (val === undefined || val === null) return val
  try {
    return JSON.parse(JSON.stringify(val))
  } catch {
    return val
  }
}

const api: DesktopApi = {
  getPathForFile(file: File) {
    return webUtils.getPathForFile(file)
  },
  selectFiles(options) {
    return ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FILES, safeClone(options))
  },
  stageInputs(paths) {
    return ipcRenderer.invoke(IPC_CHANNELS.STAGE_INPUTS, safeClone(paths))
  },
  clearStagedInputs() {
    return ipcRenderer.invoke(IPC_CHANNELS.STAGE_CLEAR)
  },
  removeStagedInputs(paths) {
    return ipcRenderer.invoke(IPC_CHANNELS.STAGE_REMOVE, safeClone(paths))
  },
  getAppVersion() {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION)
  },
  getEnvironment() {
    return ipcRenderer.invoke(IPC_CHANNELS.ENV_GET)
  },
  getPresetCatalog() {
    return ipcRenderer.invoke(IPC_CHANNELS.ENV_GET_PRESETS)
  },
  setCustomToolPaths(paths) {
    return ipcRenderer.invoke(IPC_CHANNELS.ENV_SET_CUSTOM_PATHS, safeClone(paths))
  },
  getSettings() {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET)
  },
  saveSettings(settings) {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, safeClone(settings))
  },
  createPlan(body) {
    return ipcRenderer.invoke(IPC_CHANNELS.PLAN_CREATE, safeClone(body))
  },
  startExecution(taskIds, options) {
    return ipcRenderer.invoke(IPC_CHANNELS.EXECUTION_START, safeClone(taskIds), safeClone(options))
  },
  stopExecution() {
    return ipcRenderer.invoke(IPC_CHANNELS.EXECUTION_STOP)
  },
  getExecutionStatus() {
    return ipcRenderer.invoke(IPC_CHANNELS.EXECUTION_GET_STATUS)
  },
  onEngineEvent(callback) {
    const listener = (_event: unknown, data: EngineEvent) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.EXECUTION_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.EXECUTION_EVENT, listener)
  },
  showInFolder(fullPath) {
    return ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_SHOW_IN_FOLDER, fullPath)
  },
  openPath(fullPath) {
    return ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, fullPath)
  },
  copyText(text: string) {
    // ⚠️ 不能在 preload 里直接用 electron 的 clipboard：主进程开了 sandbox:true，
    // 沙箱 preload 的 require("electron") 只暴露白名单模块，clipboard 不在其中
    // （实测为 undefined，调用即抛 "Cannot read properties of undefined"）。
    // 旧实现在这里 try/catch 吞掉异常并返回 false，而渲染层的兜底分支是
    // `if (window.api?.copyText) {...} else { navigator.clipboard... }`，
    // copyText 永远存在 → 兜底永不执行 → 点了"复制"毫无反应。
    // 改走 IPC 交主进程写入。
    return ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_COPY_TEXT, String(text ?? ""))
  },
  notify(title, body) {
    return ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_NOTIFY, safeClone({ title, body }))
  },
  onMenuAction(callback) {
    const listener = (_event: unknown, action: string) => callback(action)
    ipcRenderer.on(MENU_ACTION_CHANNEL, listener)
    return () => ipcRenderer.removeListener(MENU_ACTION_CHANNEL, listener)
  },
}

if (!process.contextIsolated) {
  throw new Error("MediaCli preload requires contextIsolation")
}

contextBridge.exposeInMainWorld("api", api)
