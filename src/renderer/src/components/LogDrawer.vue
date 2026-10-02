<script setup lang="ts">
import { ref, watch, nextTick } from "vue"
import { useLogStore } from "../stores/log"
import { useToast } from "../composables/useToast"

const logStore = useLogStore()
const toast = useToast()
const bodyRef = ref<HTMLElement | null>(null)

// 默认 680px，支持读取上次拖拽偏好
const savedW = Number(localStorage.getItem("mediac_log_drawer_width"))
const drawerWidth = ref(savedW && savedW >= 420 ? savedW : 680)
const isResizing = ref(false)

function startResizing(e: MouseEvent) {
  isResizing.value = true
  const startX = e.clientX
  const startW = drawerWidth.value

  function onMouseMove(moveEvent: MouseEvent) {
    const delta = startX - moveEvent.clientX
    const maxW = Math.round(window.innerWidth * 0.94)
    const newW = Math.max(420, Math.min(maxW, startW + delta))
    drawerWidth.value = newW
  }

  function stop() {
    isResizing.value = false
    localStorage.setItem("mediac_log_drawer_width", String(drawerWidth.value))
    window.removeEventListener("mousemove", onMouseMove)
    window.removeEventListener("mouseup", stop)
    // 指针在窗口外松开时收不到 mouseup，监听与 isResizing 会常驻
    window.removeEventListener("blur", stop)
  }

  window.addEventListener("mousemove", onMouseMove)
  window.addEventListener("mouseup", stop)
  window.addEventListener("blur", stop)
}

const isExpanded = ref(false)

function toggleExpandWidth() {
  isExpanded.value = !isExpanded.value
  if (isExpanded.value) {
    drawerWidth.value = Math.min(Math.round(window.innerWidth * 0.94), 980)
  } else {
    drawerWidth.value = 680
  }
  localStorage.setItem("mediac_log_drawer_width", String(drawerWidth.value))
}

// 监听递增序号而非 filteredLogs.length：缓冲区满 500 后长度恒定，
// watch length 会让长任务的自动滚动彻底失效。
// ⚠️ 只在用户本来就贴着底部时才自动滚动。此前无条件 scrollTop = scrollHeight，
// 用户向上翻历史时来一条 DEBUG 日志（拖动滑杆也会产生）就把视口拽回底部。
watch(
  () => `${logStore.seq}|${logStore.filter}|${logStore.focusedTaskId ?? ""}|${logStore.drawerOpen}`,
  async () => {
    if (!logStore.drawerOpen) return
    await nextTick()
    const el = bodyRef.value
    if (!el) return
    // 阈值 48px：视口底部在最后一屏之内即视为「贴底」
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (atBottom) {
      el.scrollTop = el.scrollHeight
    }
  }
)

function close() {
  logStore.drawerOpen = false
}

const copied = ref(false)

async function copyAll() {
  const text = logStore.filteredLogs.map((l) => `[${l.ts}] [${l.level}] ${l.text}`).join("\n") || "No logs"
  // 据实际结果反馈：主进程返回 false 时不再谎报「已复制」
  let ok = false
  try {
    if (window.api?.copyText) {
      ok = (await window.api.copyText(text)) !== false
    } else if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      ok = true
    }
  } catch (err) {
    console.error("Clipboard copy failed:", err)
    ok = false
  }
  if (!ok) {
    logStore.append({
      level: "ERROR",
      message: "复制日志失败：剪贴板不可用",
      timestamp: new Date().toLocaleTimeString(),
    })
    return
  }
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 2000)
}

/** 保存日志到文件（由主进程落盘到应用日志目录，渲染层不接触文件系统） */
const saved = ref(false)
async function saveLogFile() {
  // 保存**全部**日志（含未展示的 DEBUG）：导出的目的是排查问题，不应受当前筛选影响
  const text =
    logStore.logs.map((l) => `[${l.ts}] [${l.level}] ${l.text}`).join("\n") || "No logs"
  try {
    const res = await window.api?.saveLog?.(text)
    if (res?.path) {
      // 路径较长且用户可能要用它去打开文件，给足停留时间
      toast.push(`日志已保存：${res.path}`, "success", 8000)
      saved.value = true
      setTimeout(() => {
        saved.value = false
      }, 2000)
      return
    }
    toast.push("保存日志失败", "error")
  } catch (err) {
    console.error("saveLog failed:", err)
    toast.push(`保存日志失败：${err instanceof Error ? err.message : String(err)}`, "error")
  }
}
</script>

<template>
  <div v-if="logStore.drawerOpen" class="log-mask" @click="close">
    <aside
      class="log-drawer"
      :class="{ 'no-transition': isResizing }"
      :style="{ width: `${drawerWidth}px` }"
      data-testid="log-drawer"
      @click.stop
    >
      <!-- 左边缘宽度拖拽手柄 -->
      <div
        class="drawer-resizer"
        :class="{ dragging: isResizing }"
        data-testid="log-drawer-resizer"
        title="拖动调整宽度"
        @mousedown.stop="startResizing"
      ></div>

      <div class="log-head">
        <div class="log-title-zone">
          <span class="log-title">日志</span>
          <span class="log-count">{{ logStore.filteredLogs.length }} 条</span>
          <span
            v-if="logStore.focusedTaskId"
            class="focus-pill"
            title="点击取消筛选"
            @click="logStore.clearFocus"
          >
            仅看 {{ logStore.focusedTaskId }} ✕
          </span>
        </div>

        <div class="log-actions">
          <select v-model="logStore.filter" class="mini-select">
            <option value="ALL">全部</option>
            <option value="INFO">INFO</option>
            <option value="CMD">CMD</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR</option>
            <option value="DEBUG">DEBUG</option>
          </select>

          <button
            class="btn btn-sm"
            data-testid="btn-toggle-log-width"
            :title="isExpanded ? '恢复宽度' : '加宽面板'"
            @click="toggleExpandWidth"
          >
            {{ isExpanded ? '恢复宽度' : '加宽' }}
          </button>
          <button class="btn btn-sm" data-testid="btn-copy-log" @click="copyAll">
            {{ copied ? '已复制' : '复制' }}
          </button>
          <button
            class="btn btn-sm"
            data-testid="btn-save-log"
            title="把全部日志保存到应用日志目录（含未展示的 DEBUG）"
            @click="saveLogFile"
          >
            {{ saved ? '已保存' : '保存' }}
          </button>
          <button class="btn btn-sm" @click="logStore.clearLogs">清空</button>
          <button class="close-btn" data-testid="btn-close-log" @click="close">✕</button>
        </div>
      </div>

      <div ref="bodyRef" class="log-body">
        <div
          v-for="item in logStore.filteredLogs"
          :key="item.id"
          class="log-line"
          :class="'l-' + item.level"
        >
          <span class="ts">{{ item.ts }}</span>
          <span class="txt">{{ item.text }}</span>
        </div>
        <div v-if="logStore.filteredLogs.length === 0" class="log-empty">
          暂无日志
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.log-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: flex-end;
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.log-drawer {
  position: relative;
  min-width: 420px;
  max-width: 95vw;
  height: 100%;
  background: var(--bg-card);
  border-left: 1px solid var(--border-strong);
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.4);
  animation: slideLeft 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.log-drawer.no-transition {
  animation: none !important;
  transition: none !important;
}

.drawer-resizer {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  background: transparent;
  z-index: 20;
  transition: background 0.15s;
}

.drawer-resizer:hover,
.drawer-resizer.dragging {
  background: var(--primary);
}

@keyframes slideLeft {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

.log-head {
  height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.log-title-zone {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-base);
}

.log-count {
  font-size: 11px;
  color: var(--text-3);
}

.focus-pill {
  font-size: 11px;
  background: var(--warning-soft);
  color: var(--warning);
  padding: 1px 6px;
  border-radius: var(--radius);
  cursor: pointer;
  border: 1px solid rgba(242, 201, 125, 0.3);
}
.focus-pill:hover {
  opacity: 0.8;
}

.log-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mini-select {
  height: 24px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  color: var(--text-base);
  border-radius: var(--radius);
  font-size: 11px;
  padding: 0 4px;
}

.btn {
  height: 24px;
  padding: 0 8px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}
.btn:hover {
  background: var(--bg-hover);
  color: var(--text-base);
}

.close-btn {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius);
}
.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-base);
}

.log-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  background: var(--log-bg);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--log-text);
  user-select: text !important;
  -webkit-user-select: text !important;
}

.log-line {
  display: flex;
  gap: 8px;
  word-break: break-all;
  user-select: text !important;
  -webkit-user-select: text !important;
}

.ts {
  color: var(--log-ts);
  flex-shrink: 0;
  user-select: text !important;
  -webkit-user-select: text !important;
}

.l-DEBUG .txt { color: var(--log-debug); font-style: italic; }
.l-INFO .txt { color: var(--log-info); }
.l-CMD .txt { color: var(--log-cmd); font-weight: 500; }
.l-WARN .txt { color: var(--log-warn); }
.l-ERROR .txt { color: var(--log-error); font-weight: 600; }

.log-empty {
  color: var(--log-ts);
  text-align: center;
  padding: 40px 0;
}
</style>
