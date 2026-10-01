import { nextTick, watch, type Ref } from "vue"

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

/**
 * 模态焦点陷阱。
 *
 * 打开时把焦点移入容器内首个可聚焦元素，`Tab`/`Shift+Tab` 在容器内循环，
 * 关闭时把焦点还给打开前的元素。此前模态只有 `role="dialog" aria-modal="true"`
 * 的标记，键盘用户按 Tab 会跑到被遮罩的背景控件上——标记与行为不一致。
 *
 * @param containerRef 模态根元素（建议同时带 tabindex="-1" 以支持无按钮时兜底聚焦）
 * @param isActive     是否处于打开状态
 */
export function useFocusTrap(containerRef: Ref<HTMLElement | null>, isActive: Ref<boolean>) {
  let previouslyFocused: HTMLElement | null = null

  function focusableItems(): HTMLElement[] {
    const root = containerRef.value
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      // offsetParent 为 null 的通常是 display:none；模态可见时不应命中
      (el) => el.offsetParent !== null,
    )
  }

  function trapTab(event: KeyboardEvent) {
    if (event.key !== "Tab") return
    const root = containerRef.value
    if (!root) return
    const items = focusableItems()
    if (items.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement as HTMLElement | null
    const inside = active !== null && root.contains(active)

    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  watch(isActive, async (active) => {
    if (active) {
      previouslyFocused = document.activeElement as HTMLElement | null
      // 捕获阶段拦截：即使某处 stopPropagation，陷阱仍生效
      document.addEventListener("keydown", trapTab, true)
      await nextTick()
      const items = focusableItems()
      // 优先聚焦首个可聚焦项；没有则聚焦容器本身（配合 tabindex="-1"）
      if (items.length > 0) items[0].focus()
      else containerRef.value?.focus()
    } else {
      document.removeEventListener("keydown", trapTab, true)
      previouslyFocused?.focus?.()
      previouslyFocused = null
    }
  })
}
