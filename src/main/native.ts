import { BrowserWindow, Notification, clipboard, powerSaveBlocker, shell } from "electron"
import { stat } from "node:fs/promises"

let powerSaveBlockerId: number | null = null

export async function openPath(fullPath: string): Promise<string> {
  return shell.openPath(fullPath)
}

/**
 * 在文件管理器中定位文件；目录则直接打开。
 *
 * 用异步 stat 而非同步 statSync：媒体放在断开的网络盘/映射盘时，
 * 同步调用会阻塞到 OS 的网络超时（常见 20~30s），整个主进程事件循环冻结
 * （菜单无响应、IPC 全挂）。existsSync 同样已移除（它对断开的网络盘也会阻塞）。
 */
export async function showItemInFolder(fullPath: string): Promise<void> {
  try {
    const s = await stat(fullPath)
    if (s.isDirectory()) {
      await shell.openPath(fullPath)
      return
    }
  } catch {
    // 不存在或不可达：退回 shell 的定位行为
  }
  shell.showItemInFolder(fullPath)
}

/** 写入系统剪贴板（必须经主进程：沙箱 preload 里 electron.clipboard 不可用） */
export function writeClipboardText(text: string): boolean {
  try {
    clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function showNotification(title: string, body: string, onClick?: () => void): void {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body })
    if (onClick) {
      notification.on("click", onClick)
    }
    notification.show()
  }
}

export function startPreventSuspension(): void {
  if (powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension")
  }
}

export function stopPreventSuspension(): void {
  if (powerSaveBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId)
    }
    powerSaveBlockerId = null
  }
}

export function updateTaskbarProgress(progress: number, window?: BrowserWindow | null): void {
  const win = window || BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return

  if (progress < 0) {
    win.setProgressBar(-1)
  } else {
    win.setProgressBar(Math.max(0, Math.min(1, progress)))
  }
}

export function setTaskbarProgressError(window?: BrowserWindow | null): void {
  const win = window || BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  win.setProgressBar(1, { mode: "error" })
}
