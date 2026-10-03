<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue"
import { useInputIngest } from "../composables/useInputIngest"

const { ingestPaths } = useInputIngest()
const isDragging = ref(false)
let dragCounter = 0

function onDragEnter(e: DragEvent) {
  e.preventDefault()
  dragCounter++
  if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
    isDragging.value = true
  }
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  dragCounter--
  if (dragCounter <= 0) {
    dragCounter = 0
    isDragging.value = false
  }
}

function onDragOver(e: DragEvent) {
  // 只对文件拖放 preventDefault（允许 drop）：放行文本拖放，避免把任意内容
  // 拖进窗口也被当成「接受文件」。非文件拖放不会进入 drop 逻辑。
  if (e.dataTransfer && !e.dataTransfer.types.includes("Files")) return
  e.preventDefault()
}

function resetDragState() {
  dragCounter = 0
  isDragging.value = false
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  resetDragState()
  const files = Array.from(e.dataTransfer?.files || [])
  const paths = files
    .map((file) => {
      try {
        return window.api.getPathForFile(file)
      } catch {
        return ""
      }
    })
    .filter(Boolean)

  if (paths.length > 0) {
    await ingestPaths(paths)
  }
}

/**
 * capture 阶段的 window drop 监听：先于任何目标元素 handler 执行。
 *
 * ⚠️ 此前遮罩复位只挂在 window 的冒泡 drop 上，而左侧 dropzone 用
 * `@drop.stop="handleDrop"` 截断了冒泡——drop 落在 dropzone 里时本监听不执行，
 * Chromium 不保证 drop 后补发 dragleave，dragCounter 停在 ≥1，
 * 全屏半透明遮罩常驻（视觉上像应用卡死）。capture 监听不受 .stop 影响。
 */
function onWindowDropCapture() {
  resetDragState()
}

onMounted(() => {
  window.addEventListener("dragenter", onDragEnter)
  window.addEventListener("dragleave", onDragLeave)
  window.addEventListener("dragover", onDragOver)
  window.addEventListener("drop", onDrop)
  window.addEventListener("drop", onWindowDropCapture, true)
  // 拖拽中断（Esc / 松手在窗口外等）的兜底复位；外部文件拖入时本窗口不会收到
  window.addEventListener("dragend", resetDragState)
})

onUnmounted(() => {
  window.removeEventListener("dragenter", onDragEnter)
  window.removeEventListener("dragleave", onDragLeave)
  window.removeEventListener("dragover", onDragOver)
  window.removeEventListener("drop", onDrop)
  window.removeEventListener("drop", onWindowDropCapture, true)
  window.removeEventListener("dragend", resetDragState)
})
</script>

<template>
  <div
    v-if="isDragging"
    class="global-drop-mask"
    data-testid="global-drop-mask"
  >
    <div class="drop-card">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
      <div class="drop-title">释放文件以添加到转码列表</div>
      <div class="drop-sub">支持视频/音频文件或文件夹，自动按预设排程</div>
    </div>
  </div>
</template>

<style scoped>
.global-drop-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(16, 16, 20, 0.85);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  border: 3px dashed var(--primary);
}

.drop-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  background: var(--bg-card);
  padding: 32px 48px;
  border-radius: 8px;
  box-shadow: var(--shadow);
  border: 1px solid var(--border-strong);
}

.icon {
  width: 48px;
  height: 48px;
  color: var(--primary);
}

.drop-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--primary-text);
}

.drop-sub {
  font-size: 13px;
  color: var(--text-3);
}
</style>
