<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick } from "vue"
import { usePlanStore } from "../stores/plan"
import { useConfigStore } from "../stores/config"
import { useLogStore } from "../stores/log"
import { formatSize, formatDuration } from "../utils/format"
import type { PlanTask, TaskStatus } from "../../../shared/contracts"
import TaskContextMenu from "./TaskContextMenu.vue"
import { useTaskSelection } from "../composables/useTaskSelection"

const planStore = usePlanStore()
const configStore = useConfigStore()
const logStore = useLogStore()
const isDetailExpanded = ref(false)
const emit = defineEmits<{ (e: "clearAll"): void }>()

const {
  isSelected,
  handleRowClick,
  handleCheckboxClick,
  isPlanBusy,
  removeSelectedTasks,
} = useTaskSelection()

async function playMedia(filePath: string) {
  if (!filePath || !window.api?.openPath) return
  try {
    const err = await window.api.openPath(filePath)
    if (err) {
      logStore.append({
        level: "WARN",
        message: `无法直接播放: ${err}，已为您在资源管理器中定位`,
        timestamp: new Date().toLocaleTimeString(),
      })
      if (window.api?.showInFolder) {
        void window.api.showInFolder(filePath)
      }
    }
  } catch {
    if (window.api?.showInFolder) {
      void window.api.showInFolder(filePath)
    }
  }
}

function playSource(task: PlanTask, event?: MouseEvent) {
  event?.stopPropagation()
  void playMedia(task.path)
}

function playOutput(task: PlanTask, event?: MouseEvent) {
  event?.stopPropagation()
  if (task.fileDst) {
    void playMedia(task.fileDst)
  }
}

const hasMultipleSourceDirs = computed(() => {
  const dirs = new Set(
    planStore.tasks.map((t) => {
      const idx = Math.max(t.path.lastIndexOf("/"), t.path.lastIndexOf("\\"))
      return idx > 0 ? t.path.substring(0, idx) : ""
    })
  )
  return dirs.size > 1
})

async function pickOutputDir() {
  try {
    const res = await window.api.selectFiles({ mode: "directory", multiple: false })
    if (res.paths && res.paths[0]) {
      configStore.setCustomOutputDir(res.paths[0])
    }
  } catch (err) {
    console.error("pickOutputDir error:", err)
  }
}

const STATUS_MAP: Record<TaskStatus, { text: string; cls: string }> = {
  staged: { text: "待扫描", cls: "staged" },
  pending: { text: "等待中", cls: "" },
  preparing: { text: "准备中", cls: "info" },
  running: { text: "转码中", cls: "info" },
  retrying: { text: "重试中", cls: "warn" },
  success: { text: "完成", cls: "ok" },
  failed: { text: "失败", cls: "err" },
  skipped: { text: "已跳过", cls: "warn" },
  cancelled: { text: "已停止", cls: "dis" },
}

function getStatusInfo(status: TaskStatus) {
  return STATUS_MAP[status] || { text: status, cls: "" }
}

// ============ 搜索 / 状态筛选 / 排序 ============
// 仅影响**展示**：不改变 selectedIds / activeTaskId / 执行顺序。

const query = ref("")
const statusFilter = ref<string>("all")
const sortKey = ref<"index" | "size" | "duration">("index")
const sortDir = ref<"asc" | "desc">("asc")

/** 状态筛选项：等待中合并 staged/pending/preparing/retrying，与表格措辞一致 */
const STATUS_FILTERS: Array<{ value: string; label: string; match: (s: TaskStatus) => boolean }> = [
  { value: "all", label: "全部状态", match: () => true },
  {
    value: "pending",
    label: "等待中",
    match: (s) => s === "staged" || s === "pending" || s === "preparing" || s === "retrying",
  },
  { value: "running", label: "转码中", match: (s) => s === "running" },
  { value: "success", label: "完成", match: (s) => s === "success" },
  { value: "failed", label: "失败", match: (s) => s === "failed" },
  { value: "skipped", label: "已跳过", match: (s) => s === "skipped" },
  { value: "cancelled", label: "已停止", match: (s) => s === "cancelled" },
]

const isFiltering = computed(
  () => query.value.trim() !== "" || statusFilter.value !== "all",
)

function clearFilters() {
  query.value = ""
  statusFilter.value = "all"
}

/** 展示用任务列表：先筛选再排序；排序同值时按原计划序号，避免抖动 */
const visibleTasks = computed<PlanTask[]>(() => {
  const q = query.value.trim().toLowerCase()
  const filter = STATUS_FILTERS.find((f) => f.value === statusFilter.value) ?? STATUS_FILTERS[0]
  const filtered = planStore.tasks.filter((t) => {
    if (!filter.match(t.status)) return false
    if (!q) return true
    return (
      t.name.toLowerCase().includes(q) ||
      t.path.toLowerCase().includes(q) ||
      (t.fileDst || "").toLowerCase().includes(q)
    )
  })
  if (sortKey.value === "index") return filtered
  const key = sortKey.value
  const dir = sortDir.value === "asc" ? 1 : -1
  return [...filtered].sort((a, b) => {
    const av = key === "size" ? a.size : a.duration
    const bv = key === "size" ? b.size : b.duration
    if (av === bv) return a.index - b.index
    return (av - bv) * dir
  })
})

function toggleSort(key: "size" | "duration") {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc"
  } else {
    sortKey.value = key
    // 大小/时长默认降序：用户多半是想先看最大的/最长的
    sortDir.value = "desc"
  }
}

function ariaSortFor(key: "index" | "size" | "duration"): "ascending" | "descending" | "none" {
  if (sortKey.value !== key) return "none"
  return sortDir.value === "asc" ? "ascending" : "descending"
}

// ============ 失败详情展开 ============
const expandedErrorId = ref<string | null>(null)

function toggleError(id: string) {
  expandedErrorId.value = expandedErrorId.value === id ? null : id
}

async function copyError(task: PlanTask) {
  const text = task.error || task.skipReason || ""
  if (!text) return
  try {
    if (window.api?.copyText) {
      const ok = await window.api.copyText(text)
      if (ok === false) throw new Error("剪贴板不可用")
    } else {
      await navigator.clipboard.writeText(text)
    }
    logStore.append({
      level: "INFO",
      message: `已复制失败原因: ${task.name}`,
      timestamp: new Date().toLocaleTimeString(),
    })
  } catch (err) {
    logStore.append({
      level: "ERROR",
      message: `复制失败原因失败: ${err instanceof Error ? err.message : String(err)}`,
      timestamp: new Date().toLocaleTimeString(),
    })
  }
}

// 双击行：打开媒体信息与 FFmpeg 命令面板
function handleRowDblClick(task: PlanTask, event?: MouseEvent) {
  if (event && (event.target as HTMLElement).closest(".ck, .icon-btn, .t-ops")) return
  window.getSelection()?.removeAllRanges()
  planStore.activeTaskId = task.id
  planStore.inspectedTask = task
}

function removeTask(task: PlanTask, event?: MouseEvent) {
  event?.stopPropagation()
  // 运行中禁止移除：引擎仍会写盘，移除后该任务进度/结果事件静默失配
  if (isPlanBusy()) return
  planStore.removeTask(task.id)
  if (task.path) {
    configStore.removeInputs([task.path])
    if (window.api?.removeStagedInputs) {
      void window.api.removeStagedInputs([task.path])
    }
  }
  logStore.append({
    level: "INFO",
    message: `已从任务列表中移除: ${task.name}`,
    timestamp: new Date().toLocaleTimeString(),
  })
}

// ============ 队列顺序调整（上/下移） ============
// 队列顺序 = 执行顺序。仅在按「#」（执行顺序）展示且非忙碌时允许调整；
// 按大小/时长排序时表格只是视图重排，此时禁止上下移以免误改执行顺序。

const canReorder = computed(() => sortKey.value === "index" && !isPlanBusy())

function execIndex(task: PlanTask) {
  return planStore.tasks.findIndex((t) => t.id === task.id)
}

function canMove(task: PlanTask, delta: number) {
  if (!canReorder.value) return false
  const i = execIndex(task)
  const j = i + delta
  return i >= 0 && j >= 0 && j < planStore.tasks.length
}

/**
 * 上/下移任务的唯一实现。
 *
 * 渲染层的 `planStore.tasks` 顺序即执行顺序；这里先在本地换位，再用
 * `queueItems` 的 path→queueId 映射构造**全量** id 排列调主进程 `reorderQueue`
 * （主进程做全量排列校验，不一致会拒绝，故映射不全时只做本地重排不落库）。
 */
async function moveTask(task: PlanTask, delta: number, event?: MouseEvent) {
  event?.stopPropagation()
  if (!canMove(task, delta)) return
  const list = [...planStore.tasks]
  const i = execIndex(task)
  const j = i + delta
  ;[list[i], list[j]] = [list[j], list[i]]
  const orderedPaths = list.map((t) => t.path)

  const byPath = new Map(planStore.queueItems.map((q) => [q.path, q.id]))
  const ids = orderedPaths.map((p) => byPath.get(p))
  if (ids.some((id) => !id)) {
    // 队列镜像缺失（如恢复尚未完成）：仅本地重排，不落库
    planStore.applyQueueOrder(orderedPaths)
    return
  }

  try {
    const snap = await window.api.reorderQueue(ids as string[])
    planStore.setQueueItems(snap?.items)
    const paths = snap?.items?.map((x) => x.path) ?? orderedPaths
    planStore.applyQueueOrder(paths)
    configStore.setInputsFromQueue(paths)
  } catch (err) {
    logStore.append({
      level: "ERROR",
      message: `调整顺序失败: ${err instanceof Error ? err.message : String(err)}`,
      timestamp: new Date().toLocaleTimeString(),
    })
  }
}

function openInFolder(task: PlanTask, event?: MouseEvent) {
  event?.stopPropagation()
  // Before transcoding finishes, locate the existing source file;
  // Once finished, locate the generated destination file.
  const isDone = task.status === "success"
  const target = isDone ? (task.fileDst || task.path) : task.path
  if (target && window.api?.showInFolder) {
    void window.api.showInFolder(target)
  }
}

// ============ 右键常用菜单状态与操作 ============
interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  task: PlanTask | null
}

const contextMenu = ref<ContextMenuState>({
  visible: false,
  x: 0,
  y: 0,
  task: null,
})

function openContextMenu(task: PlanTask, event: MouseEvent) {
  event.preventDefault()
  planStore.activeTaskId = task.id

  const menuWidth = 220
  const menuHeight = 340
  const winW = window.innerWidth
  const winH = window.innerHeight

  let x = event.clientX
  let y = event.clientY

  if (x + menuWidth > winW) {
    x = Math.max(10, winW - menuWidth - 10)
  }
  if (y + menuHeight > winH) {
    y = Math.max(10, winH - menuHeight - 10)
  }

  contextMenu.value = {
    visible: true,
    x,
    y,
    task,
  }
}

function closeContextMenu() {
  contextMenu.value.visible = false
  contextMenu.value.task = null
}



function clearAllTasksFromMenu() {
  // 复用顶栏「清空」的唯一实现（App.vue 的 clearAll：busy 守卫 + 清 configStore.inputs +
  // 清主进程 stagedEntries），避免两处实现漂移 —— 此前这里只 setPlan(null)，曾导致
  // RUNNING 中 UI 与引擎脱钩、被清空的文件在下次规划时全量复活。
  if (isPlanBusy()) return
  emit("clearAll")
  closeContextMenu()
}

function handleGlobalKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && contextMenu.value.visible) {
    closeContextMenu()
    return
  }
  // 键盘呼出右键菜单（无障碍要求：Shift+F10 / ContextMenu 键），
  // 定位到当前激活行；无激活行则退回首行，仍无任务则不打开。
  if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
    const task =
      planStore.tasks.find((t) => t.id === planStore.activeTaskId) || planStore.tasks[0] || null
    if (!task) return
    e.preventDefault()
    planStore.activeTaskId = task.id
    const row = document.querySelector<HTMLElement>(
      `tr[data-task-id="${CSS.escape(task.id)}"]`
    )
    const rect = row?.getBoundingClientRect()
    const x = rect ? Math.max(10, Math.min(rect.left + 24, window.innerWidth - 230)) : 40
    const y = rect ? Math.max(10, Math.min(rect.top + 20, window.innerHeight - 350)) : 40
    contextMenu.value = { visible: true, x, y, task }
    void nextTick(() => {
      const first = document.querySelector<HTMLElement>(".ctx-menu .ctx-item")
      first?.focus()
    })
  }
}


onMounted(() => {
  window.addEventListener("click", closeContextMenu)
  window.addEventListener("resize", closeContextMenu)
  window.addEventListener("keydown", handleGlobalKeydown)
})

onUnmounted(() => {
  window.removeEventListener("click", closeContextMenu)
  window.removeEventListener("resize", closeContextMenu)
  window.removeEventListener("keydown", handleGlobalKeydown)
})

function inspectTask(task: PlanTask, event: MouseEvent) {
  event.stopPropagation()
  planStore.inspectedTask = task
}

function focusTaskLog(task: PlanTask, event: MouseEvent) {
  event.stopPropagation()
  logStore.focusTask(task.id)
  logStore.drawerOpen = true
}

function getBaseName(filePath: string) {
  if (!filePath) return "—"
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || filePath
}

function getDirName(filePath: string) {
  if (!filePath) return ""
  const parts = filePath.split(/[/\\]/)
  if (parts.length <= 1) return ""
  return parts.slice(0, -1).join("/")
}


function isRowSelectedOrActive(id: string) {
  return planStore.activeTaskId === id || planStore.selectedIds.has(id)
}

function isRowActive(id: string) {
  return planStore.activeTaskId === id
}

function getFmtText(name: string) {
  if (!name) return "FILE"
  const m = name.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toUpperCase() : "FILE"
}

function getFmtClass(name: string) {
  const ext = getFmtText(name).toLowerCase()
  if (ext === "mp4") return "fmt-mp4"
  if (ext === "mkv") return "fmt-mkv"
  if (ext === "webm") return "fmt-webm"
  if (ext === "mov") return "fmt-mov"
  if (ext === "avi") return "fmt-avi"
  if (ext === "ts" || ext === "m2ts") return "fmt-ts"
  return "fmt-other"
}

// 快速对比底板：优先展示当前激活聚焦项，或检查项，或勾选项，或首项
const selectedTask = computed(() => {
  return planStore.inspectedTask
    || (planStore.activeTaskId ? planStore.tasks.find((task) => task.id === planStore.activeTaskId) : null)
    || planStore.tasks.find((task) => planStore.selectedIds.has(task.id))
    || planStore.tasks[0]
    || null
})

/**
 * 源规格文本。
 * ⚠️ 旧写法直接把 width/height/fps 插值进模板，而这些字段在契约里都是可选的：
 * 元数据探测未完成（staged 任务）或缺失时会渲染成 "undefinedxundefined · undefinedfps"。
 */
const sourceSpecText = computed(() => {
  const t = selectedTask.value
  if (!t) return "未知"
  const parts: string[] = []
  if (t.width && t.height) parts.push(`${t.width}x${t.height}`)
  if (t.fps) parts.push(`${t.fps}fps`)
  return parts.length > 0 ? parts.join(" · ") : "未知"
})

/** 目标规格文本：与源规格同口径，缺项显示占位而非 undefined */
const targetSpecText = computed(() => {
  const t = selectedTask.value
  if (!t) return "未知"
  const ts = t.targetSummary
  const w = ts?.width || t.width
  const h = ts?.height || t.height
  const parts: string[] = []
  parts.push(w && h ? `${w}x${h}` : "与源文件相同")
  const fps = ts?.fps || t.fps
  parts.push(fps ? `${fps}fps` : "原帧率")
  return parts.join(" · ")
})

const selectedTaskPreview = computed(() => {
  const t = selectedTask.value
  if (!t) return null
  const src = [
    t.containerFormat || getFmtText(t.name),
    t.width && t.height ? `${t.width}x${t.height}` : "",
    t.fps ? `${t.fps}fps` : "",
    t.videoCodec ? t.videoCodec.toUpperCase() : "",
    t.audioCodec ? t.audioCodec.toUpperCase() : "",
    formatSize(t.size),
    formatDuration(t.duration),
  ].filter(Boolean).join(" · ")

  const ts = t.targetSummary
  const dstParts = []
  if (ts?.width && ts?.height) dstParts.push(`${ts.width}x${ts.height}`)
  if (ts?.fps) dstParts.push(`${ts.fps}fps`)
  if (ts?.videoEncoder) dstParts.push(ts.videoEncoder)
  if (ts?.quality) dstParts.push(`CRF ${ts.quality}`)
  else if (ts?.bitrate) dstParts.push(`${Math.round(ts.bitrate / 1000)}k`)
  if (ts?.audioCodec) dstParts.push(ts.audioCodec.toUpperCase())
  if (ts?.container) dstParts.push(ts.container.toUpperCase())

  const dst = dstParts.length > 0
    ? dstParts.join(" · ")
    : t.fileDst
      ? `${getBaseName(t.fileDst)} · [${planStore.planSnapshot?.presetName || '预设'}]`
      : `[未扫描] 使用当前设置`

  return { name: t.name, srcText: src, dstText: dst, task: t }
})
</script>

<template>
  <div class="table-container" data-testid="table-container">
    <!-- 搜索 / 状态筛选 / 排序：仅改变展示，不影响勾选与执行顺序 -->
    <div class="table-toolbar" data-testid="table-toolbar">
      <input
        v-model="query"
        type="search"
        class="tb-search"
        placeholder="搜索文件名 / 路径…"
        aria-label="搜索任务"
        data-testid="input-task-search"
      />
      <select
        v-model="statusFilter"
        class="tb-filter"
        aria-label="按状态筛选"
        data-testid="select-status-filter"
      >
        <option v-for="f in STATUS_FILTERS" :key="f.value" :value="f.value">{{ f.label }}</option>
      </select>
      <span class="tb-count" data-testid="task-filter-count">
        {{ visibleTasks.length }} / {{ planStore.tasks.length }}
      </span>
      <button
        v-if="isFiltering"
        class="btn btn-sm btn-ghost"
        data-testid="btn-clear-filter"
        @click="clearFilters"
      >
        清除筛选
      </button>
    </div>

    <div class="table-body-scroll">
      <table class="tasks" data-testid="tasks-table">
        <colgroup>
          <col style="width: 36px" />
          <col style="width: 38px" />
          <col style="width: 26%" />
          <col style="width: 84px" />
          <col style="width: 80px" />
          <col style="width: 130px" />
          <col style="width: 24%" />
          <col style="width: 120px" />
          <col style="width: 140px" />
        </colgroup>
        <thead>
          <tr>
            <th>
              <span
                class="ck"
                :class="{ on: planStore.isAllSelected }"
                data-testid="ck-all"
                role="checkbox"
                :aria-checked="planStore.isAllSelected"
                tabindex="0"
                title="全选 / 取消全选"
                @click.left="planStore.toggleAll"
                @keydown.space.prevent="planStore.toggleAll"
              ></span>
            </th>
            <th>#</th>
            <th>源文件</th>
            <th :aria-sort="ariaSortFor('size')">
              <button class="sort-btn" data-testid="sort-size" @click="toggleSort('size')">
                大小
                <span class="sort-arrow">{{ sortKey === 'size' ? (sortDir === 'asc' ? '▲' : '▼') : '' }}</span>
              </button>
            </th>
            <th :aria-sort="ariaSortFor('duration')">
              <button class="sort-btn" data-testid="sort-duration" @click="toggleSort('duration')">
                时长
                <span class="sort-arrow">{{ sortKey === 'duration' ? (sortDir === 'asc' ? '▲' : '▼') : '' }}</span>
              </button>
            </th>
            <th>解码 → 编码</th>
            <th>目标文件</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody data-testid="tasks-tbody">
          <template v-for="task in visibleTasks" :key="task.id">
          <tr
            :class="{
              sel: isRowSelectedOrActive(task.id),
              active: isRowActive(task.id),
              checked: isSelected(task.id),
              dim: task.status === 'skipped'
            }"
            data-testid="task-row"
            :data-task-id="task.id"
            @click="handleRowClick(task, $event)"
            @dblclick="handleRowDblClick(task, $event)"
            @contextmenu.prevent.stop="openContextMenu(task, $event)"
          >
            <td class="ck-cell" @click.stop>
              <span
                class="ck"
                :class="{ on: isSelected(task.id) }"
                data-testid="task-checkbox"
                role="checkbox"
                :aria-checked="isSelected(task.id)"
                tabindex="0"
                title="勾选 / 取消勾选"
                @click.left.stop="handleCheckboxClick(task, $event)"
                @keydown.space.prevent="planStore.toggleTask(task.id)"
              ></span>
            </td>
            <td class="t-num">{{ task.index + 1 }}</td>
            <td>
              <div class="t-main" :title="task.name">
                <span class="fmt-tag" :class="getFmtClass(task.name)">{{ getFmtText(task.name) }}</span>
                <span>{{ task.name }}</span>
              </div>
              <div class="t-sub" :title="task.path">{{ getDirName(task.path) }}</div>
            </td>
            <td class="t-meta">{{ formatSize(task.size) }}</td>
            <td class="t-meta">{{ formatDuration(task.duration) }}</td>
            <td>
              <div class="codec-tag">
                <span class="c-src">{{ task.videoCodec || 'auto' }}</span>
                <span class="c-arrow">→</span>
                <span class="c-dst">{{ planStore.planSnapshot?.presetName || 'target' }}</span>
              </div>
            </td>
            <td>
              <div v-if="task.fileDst" class="t-main" :title="task.fileDst">{{ getBaseName(task.fileDst) }}</div>
              <div v-else class="t-main t-staged">[未扫描] 使用当前设置</div>
              <div v-if="task.fileDst" class="t-sub" :title="task.fileDst">{{ getDirName(task.fileDst) }}</div>
            </td>
            <td>
              <div class="status-cell">
                <span
                  class="tag"
                  :class="getStatusInfo(task.status).cls"
                  data-testid="task-status"
                  :title="task.error || task.skipReason || ''"
                >
                  {{ getStatusInfo(task.status).text }}
                </span>
                <div v-if="task.status === 'running'" class="row-bar">
                  <i :style="{ width: `${task.progress || 0}%` }"></i>
                </div>
                <button
                  v-if="task.status === 'failed'"
                  class="err-toggle"
                  :aria-expanded="expandedErrorId === task.id"
                  title="查看失败原因"
                  data-testid="btn-toggle-error"
                  @click.stop="toggleError(task.id)"
                >
                  详情
                </button>
              </div>
            </td>
            <td>
              <div class="t-ops">
                <button
                  class="icon-btn"
                  title="播放源视频"
                  data-testid="btn-play-source"
                  @click="playSource(task, $event)"
                >
                  <svg class="i sm" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="6 4 18 12 6 20 6 4" />
                  </svg>
                </button>
                <button
                  v-if="task.status === 'success'"
                  class="icon-btn ok-icon"
                  title="播放转码产物"
                  data-testid="btn-play-output"
                  @click="playOutput(task, $event)"
                >
                  <svg class="i sm" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" />
                    <polygon points="10 8 16 12 10 16 10 8" />
                  </svg>
                </button>
                <button
                  class="icon-btn"
                  title="查看媒体信息与 FFmpeg 命令"
                  data-testid="btn-inspect-task"
                  @click="inspectTask(task, $event)"
                >
                  <svg class="i sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </button>
                <button
                  class="icon-btn"
                  title="在资源管理器中定位"
                  data-testid="btn-show-in-folder"
                  @click="openInFolder(task, $event)"
                >
                  <svg class="i sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
                <button
                  v-if="task.status === 'failed'"
                  class="icon-btn err-icon"
                  title="查看失败错误日志"
                  data-testid="btn-task-log"
                  @click="focusTaskLog(task, $event)"
                >
                  <svg class="i sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </button>
                <button
                  class="icon-btn"
                  title="上移（调整执行顺序）"
                  data-testid="btn-move-up"
                  :disabled="!canMove(task, -1)"
                  @click="moveTask(task, -1, $event)"
                >
                  <svg class="i sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
                <button
                  class="icon-btn"
                  title="下移（调整执行顺序）"
                  data-testid="btn-move-down"
                  :disabled="!canMove(task, 1)"
                  @click="moveTask(task, 1, $event)"
                >
                  <svg class="i sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <polyline points="19 12 12 19 5 12" />
                  </svg>
                </button>
                <button
                  class="icon-btn del-btn"
                  title="从任务列表中移除"
                  data-testid="btn-remove-task"
                  @click="removeTask(task, $event)"
                >
                  <svg class="i sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </td>
          </tr>

          <!-- 失败/跳过原因展开行 -->
          <tr
            v-if="expandedErrorId === task.id"
            class="err-row"
            :data-testid="`task-error-${task.id}`"
          >
            <td colspan="9">
              <div class="err-box">
                <span class="err-text selectable">{{ task.error || task.skipReason || '未知错误' }}</span>
                <div class="err-ops">
                  <button
                    class="btn btn-sm btn-secondary"
                    data-testid="btn-copy-error"
                    @click.stop="copyError(task)"
                  >
                    复制错误
                  </button>
                  <button
                    class="btn btn-sm btn-secondary"
                    data-testid="btn-error-log"
                    @click.stop="focusTaskLog(task, $event)"
                  >
                    查看日志
                  </button>
                </div>
              </div>
            </td>
          </tr>
          </template>

          <tr v-if="visibleTasks.length === 0" class="no-match-row" data-testid="no-match-row">
            <td colspan="9">
              {{ planStore.tasks.length === 0 ? '暂无任务' : '无匹配任务，试试清除筛选' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 列表底部操作与当前任务摘要 -->
    <div class="table-bottom-bar" data-testid="table-bottom-bar">
      <div class="bottom-top-row">
        <div class="tb-actions">
          <button
            class="btn btn-sm btn-secondary"
            data-testid="btn-toggle-all"
            title="全选或取消全选 (Space)"
            @click="planStore.toggleAll"
          >
            <svg class="i sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 11 12 14 22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <span>{{ planStore.isAllSelected ? '取消全选' : '全选' }}</span>
          </button>
          <button
            class="btn btn-sm btn-secondary"
            data-testid="btn-remove-selected"
            :disabled="planStore.selectedIds.size === 0 || isPlanBusy()"
            title="从列表中删除勾选的任务"
            @click="removeSelectedTasks"
          >
            <svg class="i sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            <span>删除所选 ({{ planStore.selectedIds.size }})</span>
          </button>
        </div>

        <!-- 当前任务摘要（默认态） -->
        <div v-if="selectedTaskPreview && !isDetailExpanded" class="tb-preview" data-testid="task-quick-preview">
          <div class="pv-col pv-src" :title="selectedTaskPreview.name">
            <span class="pv-label">源文件:</span>
            <span class="pv-val">{{ selectedTaskPreview.srcText }}</span>
          </div>
          <div class="pv-sep">→</div>
          <div class="pv-col pv-dst">
            <span class="pv-label">输出:</span>
            <span class="pv-val">{{ selectedTaskPreview.dstText }}</span>
          </div>
          <button
            class="btn-detail-toggle"
            data-testid="btn-detail-toggle"
            title="切换展开/收起详细规格对比"
            @click="isDetailExpanded = true"
          >
            详情 ▾
          </button>
        </div>
        <div v-else-if="!selectedTaskPreview" class="tb-summary">
          共 {{ planStore.tasks.length }} 个文件 · 总计 {{ formatSize(planStore.totalSize) }} · 时长 {{ formatDuration(planStore.totalDuration) }}
        </div>
      </div>

      <!-- 展开态：Shana 风格结构化双栏详细对比卡片 -->
      <div v-if="selectedTaskPreview && isDetailExpanded" class="shana-compare-card" data-testid="shana-compare-card">
        <div class="card-head">
          <span class="card-title">媒体详细对比：{{ selectedTaskPreview.name }}</span>
          <button
            class="btn-detail-toggle"
            data-testid="btn-collapse-detail"
            @click="isDetailExpanded = false"
          >
            收起 ▴
          </button>
        </div>
        <div class="card-grid">
          <div class="card-col card-src">
            <div class="col-title">源文件</div>
            <div class="card-item"><span>分辨率：</span><b>{{ sourceSpecText }}</b></div>
            <div class="card-item"><span>编码：</span><b>{{ selectedTaskPreview.task.videoCodec || '未知' }} / {{ selectedTaskPreview.task.audioCodec || '未知' }}</b></div>
            <div class="card-item"><span>大小：</span><b>{{ formatSize(selectedTaskPreview.task.size) }} ({{ formatDuration(selectedTaskPreview.task.duration) }})</b></div>
            <div class="card-item truncate" :title="selectedTaskPreview.task.path"><span>路径：</span>{{ selectedTaskPreview.task.path }}</div>
          </div>
          <div class="card-col card-dst">
            <div class="col-title">输出设置</div>
            <div class="card-item"><span>输出分辨率：</span><b>{{ targetSpecText }}</b></div>
            <div class="card-item"><span>输出编码：</span><b>{{ selectedTaskPreview.task.targetSummary?.videoEncoder || '自动编码' }} · {{ selectedTaskPreview.task.targetSummary?.audioCodec || 'aac' }}</b></div>
            <div class="card-item"><span>质量：</span><b>{{ selectedTaskPreview.task.targetSummary?.quality ? 'CRF ' + selectedTaskPreview.task.targetSummary.quality : selectedTaskPreview.task.targetSummary?.bitrate ? Math.round(selectedTaskPreview.task.targetSummary.bitrate / 1000) + 'k' : '自动' }}</b></div>
            <div class="card-item truncate" :title="selectedTaskPreview.task.fileDst || '同源文件目录'"><span>输出路径：</span>{{ selectedTaskPreview.task.fileDst || (configStore.outputBesideSource ? '与源文件同级' : configStore.outputDir || '与源文件同级') }}</div>
          </div>
        </div>
      </div>

      <!-- 常驻输出路径条 (对标 Shana/HandBrake) -->
      <div class="output-dest-bar" data-testid="output-dest-bar">
        <label class="dest-ck-label" title="输出到每个源文件所在的文件夹">
          <input
            type="checkbox"
            class="dest-ck"
            data-testid="ck-dest-beside"
            :checked="configStore.outputBesideSource"
            @change="configStore.setOutputBesideSource(($event.target as HTMLInputElement).checked)"
          />
          <span>与源文件同级</span>
        </label>
        <div v-if="!configStore.outputBesideSource" class="custom-dest-box">
          <input
            type="text"
            class="dest-input"
            data-testid="input-dest-dir"
            placeholder="自定义输出目录路径…"
            :value="configStore.outputDir"
            @input="configStore.setCustomOutputDir(($event.target as HTMLInputElement).value)"
            @change="configStore.commitCustomOutputDir(($event.target as HTMLInputElement).value)"
          />
          <button class="btn btn-sm btn-secondary" data-testid="btn-browse-dest" @click="pickOutputDir">更改…</button>
        </div>
        <span v-if="hasMultipleSourceDirs && configStore.outputBesideSource" class="multi-dir-hint">
          （每个文件输出到各自的源文件夹）
        </span>
      </div>
    </div>

    <!-- 自定义右键常用菜单组件 -->
    <TaskContextMenu
      :visible="contextMenu.visible"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :task="contextMenu.task"
      :is-busy="isPlanBusy()"
      @close="closeContextMenu"
      @play-source="playSource"
      @play-output="playOutput"
      @inspect="(task) => { planStore.inspectedTask = task }"
      @open-in-folder="openInFolder"
      @remove-task="removeTask"
      @remove-selected="removeSelectedTasks"
      @clear-all="clearAllTasksFromMenu"
    />
  </div>
</template>

<style scoped>
.table-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.table-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--divider);
  background: var(--bg-card);
}

.tb-search {
  flex: 1;
  min-width: 120px;
  max-width: 340px;
  height: 26px;
  padding: 0 9px;
  font-size: 12px;
  font-family: var(--font);
  color: var(--text-base);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.tb-search:focus {
  outline: none;
  border-color: var(--primary);
}

.tb-filter {
  height: 26px;
  padding: 0 6px;
  font-size: 12px;
  font-family: var(--font);
  color: var(--text-base);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.tb-count {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  margin-left: auto;
}

.sort-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.sort-btn:hover {
  color: var(--primary-text);
}

.sort-arrow {
  font-size: 8px;
  min-width: 8px;
}

.no-match-row td {
  padding: 28px 12px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
}

.err-toggle {
  margin-top: 4px;
  padding: 0 6px;
  height: 18px;
  font-size: 10px;
  line-height: 1;
  color: var(--error);
  background: var(--error-soft);
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
}

.err-toggle:hover {
  border-color: var(--error);
}

.err-row td {
  padding: 0 !important;
  background: var(--error-soft);
}

.err-box {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 14px 10px 46px;
}

.err-text {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--error);
  white-space: pre-wrap;
  word-break: break-word;
}

.err-ops {
  flex: none;
  display: flex;
  gap: 6px;
}

.table-body-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: auto;
  position: relative;
}

table.tasks {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

table.tasks th {
  position: sticky;
  top: 0;
  background: var(--bg-table-head);
  backdrop-filter: blur(8px);
  z-index: 5;
  text-align: left;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3);
  padding: 8px 10px;
  border-bottom: 1px solid var(--divider);
  white-space: nowrap;
}

table.tasks td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--divider);
  vertical-align: middle;
  font-size: 12px;
}

tbody tr {
  cursor: pointer;
  transition: background-color 0.12s;
}

tbody tr:hover {
  background: var(--bg-hover);
}

tbody tr.sel {
  background: var(--primary-soft);
}

tbody tr.dim {
  opacity: 0.55;
}

.t-num {
  color: var(--text-3);
  font-size: 11px;
}

.t-main {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-base);
  font-weight: 500;
}

.t-sub {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
  font-family: var(--mono);
}

.t-meta {
  color: var(--text-2);
  font-family: var(--mono);
  font-size: 11px;
  white-space: nowrap;
}

.codec-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-2);
}

.c-src {
  color: var(--info);
}

.c-arrow {
  color: var(--text-3);
}

.c-dst {
  color: var(--primary-text);
  font-weight: 600;
}

.status-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.row-bar {
  height: 3px;
  border-radius: 2px;
  background: var(--bg-active);
  overflow: hidden;
  width: 80px;
}

.row-bar i {
  display: block;
  height: 100%;
  background: var(--primary);
  transition: width 0.2s;
}

.ck {
  width: 16px;
  height: 16px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: transparent;
  flex: none;
  vertical-align: middle;
  transition: background 0.12s, border-color 0.12s;
}

.ck::after {
  content: '✓';
  font-size: 11px;
  font-weight: 700;
  opacity: 0;
  transition: opacity 0.1s;
}

.ck.on::after {
  opacity: 1;
}

.ck.on {
  background: var(--primary);
  border-color: var(--primary);
  color: #101014;
}

[data-theme="light"] .ck.on {
  color: #fff;
}

.tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 3px;
  font-size: 11px;
  background: var(--bg-active);
  /* 深色主题下 --text-2(#9198a1) on --bg-active(#30363d) 实测仅 4.19:1，
     低于 WCAG AA 正文 4.5:1（11px 属正文而非大字）。改用 --text-base
     (#f0f6fc on #30363d ≈ 10.4:1）；浅色主题 --text-base(#1f2328 on
     #d0d7de) 同样远高于阈值，故可统一用 --text-base。 */
  color: var(--text-base);
  white-space: nowrap;
}

.tag.info {
  background: var(--info-soft);
  color: var(--info);
}

.tag.ok {
  background: var(--primary-soft);
  color: var(--primary-text);
}

.tag.err {
  background: var(--error-soft);
  color: var(--error);
}

.tag.warn {
  background: var(--warning-soft);
  color: var(--warning);
}

.tag.staged {
  background: var(--warning-soft);
  color: var(--warning);
  font-weight: 500;
}

.t-staged {
  color: var(--text-3);
  font-style: italic;
  font-size: 11px;
}

/* 格式彩标 (对标 ShanaEncoder) */
.fmt-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 3px;
  margin-right: 6px;
  line-height: 1.2;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.fmt-mp4 {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
  border: 1px solid rgba(59, 130, 246, 0.3);
}

.fmt-mkv {
  background: rgba(168, 85, 247, 0.15);
  color: #a855f7;
  border: 1px solid rgba(168, 85, 247, 0.3);
}

.fmt-webm {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.fmt-mov {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.fmt-avi {
  background: rgba(236, 72, 153, 0.15);
  color: #ec4899;
  border: 1px solid rgba(236, 72, 153, 0.3);
}

.fmt-ts {
  background: rgba(99, 102, 241, 0.15);
  color: #6366f1;
  border: 1px solid rgba(99, 102, 241, 0.3);
}

.fmt-other {
  background: var(--bg-active);
  color: var(--text-2);
  border: 1px solid var(--border);
}

.tag.dis {
  opacity: 0.5;
}

.t-ops {
  display: flex;
  gap: 4px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-base);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.icon-btn:disabled:hover {
  background: transparent;
  color: var(--text-3);
}

.icon-btn.err-icon {
  color: var(--error);
}

.icon-btn.err-icon:hover {
  background: var(--error-soft);
}

.icon-btn.del-btn:hover {
  background: var(--error-soft);
  color: var(--error);
}

.icon-btn.ok-icon {
  color: var(--success, #10b981);
}

.icon-btn.ok-icon:hover {
  background: rgba(16, 185, 129, 0.12);
}

/* 底部操作与预览底板 (对标 ShanaEncoder) */
.table-bottom-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--divider);
  background: var(--bg-card);
  font-size: 12px;
  flex-shrink: 0;
}

.bottom-top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 32px;
}

.btn-detail-toggle {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 11px;
  color: var(--primary);
  padding: 2px 8px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.12s;
}

.btn-detail-toggle:hover {
  background: var(--primary-soft);
}

.shana-compare-card {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px dashed var(--divider);
  padding-bottom: 4px;
}

.card-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}

.card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.card-col {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
}

.col-title {
  font-weight: 600;
  color: var(--primary);
  margin-bottom: 2px;
}

.card-item {
  display: flex;
  gap: 6px;
  color: var(--text-2);
}

.card-item span {
  color: var(--text-3);
  flex-shrink: 0;
}

.card-item b {
  color: var(--text-base);
  font-family: var(--mono);
}

.card-item.truncate {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--mono);
  font-size: 10px;
}

.output-dest-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}

.dest-ck-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-base);
  cursor: pointer;
  user-select: none;
  font-weight: 500;
}

.dest-ck {
  accent-color: var(--primary);
  cursor: pointer;
}

.custom-dest-box {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  max-width: 460px;
}

.dest-input {
  flex: 1;
  height: 24px;
  font-size: 11px;
  font-family: var(--mono);
  padding: 0 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-base);
}

.multi-dir-hint {
  font-size: 11px;
  color: var(--text-3);
}

.tb-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.tb-summary {
  color: var(--text-3);
  font-size: 11px;
}

.tb-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  padding: 4px 10px;
  background: var(--bg-hover);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  overflow: hidden;
}

.pv-col {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
}

.pv-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  flex-shrink: 0;
}

.pv-val {
  font-size: 11px;
  color: var(--text-base);
  overflow: hidden;
  text-overflow: ellipsis;
}

.pv-sep {
  color: var(--primary);
  font-weight: 700;
  flex-shrink: 0;
  font-size: 12px;
}

svg.i {
  width: 14px;
  height: 14px;
  flex: none;
}

svg.i.sm {
  width: 13px;
  height: 13px;
}

.ck-cell {
  user-select: none;
  text-align: center;
}

tbody tr.active {
  outline: 1px solid var(--primary);
  outline-offset: -1px;
}

tbody tr.checked {
  background: var(--primary-soft);
}

/* 按钮样式补全（防外部穿透缺失） */
.btn {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  font-family: var(--font);
  font-weight: 500;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-base);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  user-select: none;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.btn:active:not(:disabled) {
  background: var(--bg-active);
}

.btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
  pointer-events: none;
}

.btn-sm {
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
}

.btn-secondary {
  border-color: var(--border);
  background: var(--bg-input);
  color: var(--text-base);
}

.btn-secondary:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}


</style>
