import { ref } from "vue"

export type ToastType = "info" | "success" | "warn" | "error"

export interface ToastItem {
  id: number
  type: ToastType
  message: string
}

/**
 * 应用内提示队列（模块级单例：任意组件共用同一条队列，由根部的 ToastHost 统一渲染）。
 *
 * 取代 `alert()`：原生弹窗是阻断式的、不可复制、风格割裂，在 Electron 中
 * 还会冻结渲染进程。这里的提示是非阻断、可关闭、可被读屏播报的。
 */
const toasts = ref<ToastItem[]>([])
let seq = 0

export function useToast() {
  /** 关闭单条提示 */
  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  /**
   * 推入一条提示。
   * @param durationMs 自动消失时间；<= 0 表示常驻（需用户手动关闭）
   */
  function push(message: string, type: ToastType = "info", durationMs = 4000): number {
    const id = ++seq
    toasts.value = [...toasts.value, { id, type, message: String(message ?? "") }]
    if (durationMs > 0) {
      setTimeout(() => dismiss(id), durationMs)
    }
    return id
  }

  return { toasts, push, dismiss }
}
