<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue"
import HeaderBar from "./components/HeaderBar.vue"
import StatusBar from "./components/StatusBar.vue"
import GlobalDropMask from "./components/GlobalDropMask.vue"
import ConfigPanel from "./components/ConfigPanel.vue"
import HeroEmpty from "./components/HeroEmpty.vue"
import TaskTable from "./components/TaskTable.vue"
import ExecutionBoard from "./components/ExecutionBoard.vue"
import TaskInspectorDrawer from "./components/TaskInspectorDrawer.vue"
import LogDrawer from "./components/LogDrawer.vue"
import SettingsModal from "./components/SettingsModal.vue"
import AboutModal from "./components/AboutModal.vue"
import ToastHost from "./components/ToastHost.vue"

import { useEnvStore } from "./stores/env"
import { useConfigStore } from "./stores/config"
import { usePlanStore } from "./stores/plan"
import { useLogStore } from "./stores/log"
import { formatSize, formatDuration } from "./utils/format"
import { useInputIngest } from "./composables/useInputIngest"
import { useToast } from "./composables/useToast"
import { MENU_ACTIONS } from "../../shared/ipc-channels"
import type { EngineEvent } from "../../shared/contracts"

const envStore = useEnvStore()
const configStore = useConfigStore()
const planStore = usePlanStore()
const logStore = useLogStore()
const { ingestPaths, isIngesting } = useInputIngest()
const toast = useToast()

// Sidebar resizer & collapse state
const sidebarWidth = ref(380)
const isSidebarCollapsed = ref(false)
const isResizing = ref(false)
const showSettings = ref(false)
const showAbout = ref(false)
/** 用户手动切换过侧栏后不再自动折叠（尊重显式意图） */
const sidebarTouchedByUser = ref(false)

function toggleSidebar() {
  sidebarTouchedByUser.value = true
  isSidebarCollapsed.value = !isSidebarCollapsed.value
}

/**
 * 窄窗口自动折叠侧栏。
 *
 * 表格用 `table-layout: fixed` + 百分比列（源文件 26% / 目标文件 24%），
 * 而固定列合计 628px。窗口 960px（应用允许的最小宽度）时主区只剩 561px，
 * 固定列先把空间吃光，两个百分比列被压到 **0px** —— 实测「源文件」与
 * 「目标文件」两列宽度为 0，内容完全不可见（不是横向滚动能解决的）。
 * 折叠侧栏后主区约 900px，各列恢复正常。
 * 只在跨过阈值时触发一次，且用户手动切换过之后不再干预。
 */
const NARROW_AUTO_COLLAPSE_PX = 1080
function applyNarrowAutoCollapse() {
  if (sidebarTouchedByUser.value) return
  const narrow = window.innerWidth < NARROW_AUTO_COLLAPSE_PX
  if (narrow && !isSidebarCollapsed.value) {
    isSidebarCollapsed.value = true
  } else if (!narrow && isSidebarCollapsed.value) {
    isSidebarCollapsed.value = false
  }
}

function startResizing(e: MouseEvent) {
  isResizing.value = true
  const startX = e.clientX
  const startW = sidebarWidth.value

  function onMouseMove(moveEvent: MouseEvent) {
    const delta = moveEvent.clientX - startX
    const newW = Math.max(320, Math.min(560, startW + delta))
    sidebarWidth.value = newW
  }

  function stop() {
    isResizing.value = false
    window.removeEventListener("mousemove", onMouseMove)
    window.removeEventListener("mouseup", stop)
    // ⚠️ 指针在窗口外松开时收不到 window 的 mouseup，监听与 isResizing 会常驻，
    // 重新移入窗口时侧栏宽度会继续跟着鼠标变。blur 兜底解绑。
    window.removeEventListener("blur", stop)
  }

  window.addEventListener("mousemove", onMouseMove)
  window.addEventListener("mouseup", stop)
  window.addEventListener("blur", stop)
}

/**
 * 引擎事件 -> Pinia store 的唯一映射。
 * 抽成模块级函数是为了让 onMounted 能在**任何 await 之前**完成订阅
 * （见 onMounted 内的说明：preload 侧没有事件缓冲/重放）。
 */
function handleEngineEvent(event: EngineEvent) {
  if (event.type === "task.log") {
    logStore.append({
      level: event.level || "INFO",
      message: event.message || "",
      taskId: event.taskId,
      timestamp: event.timestamp || new Date().toLocaleTimeString(),
    })
  } else if (event.type === "task.started") {
    planStore.updateTaskStatus(event.taskId, "running")
  } else if (event.type === "task.progress") {
    planStore.updateTaskProgress(event.taskId, event.percent || 0, event.speed)
  } else if (event.type === "task.done") {
    // 失败任务同样发 task.done（engine 无 task.failed 事件），靠 failed 标记区分
    if (event.failed === true) {
      planStore.updateTaskStatus(event.taskId, "failed", event.result?.error || "转码失败")
    } else {
      planStore.updateTaskStatus(event.taskId, "success")
    }
  } else if (event.type === "task.skipped") {
    planStore.updateTaskStatus(event.taskId, "skipped", event.reason)
  } else if (event.type === "task.cancelled") {
    planStore.updateTaskStatus(event.taskId, "cancelled")
  } else if (event.type === "session.summary") {
    const summary = event.summary
    const failedCount = typeof summary?.failed === "number" ? summary.failed : 0
    const pendingStaleBefore = planStore.pendingStale
    planStore.status = summary?.isCancelled
      ? "STOPPED"
      : failedCount > 0
        ? "FAILED"
        : "COMPLETED"
    // 运行期间修改过的配置在此刻兑现为 STALE：不能让它随终态一起被吞掉
    planStore.applyPendingStale()
    const total = summary?.total || 0
    const succeeded = typeof summary?.success === "number" ? summary.success : 0
    logStore.append({
      level: failedCount > 0 ? "ERROR" : "INFO",
      message: `转码结束：共 ${total} 个任务，成功 ${succeeded} 个，失败 ${failedCount} 个，跳过 ${summary?.skipped || 0} 个，耗时 ${((summary?.elapsedMs || 0) / 1000).toFixed(1)} 秒`,
      timestamp: new Date().toLocaleTimeString(),
    })
    if (pendingStaleBefore) {
      logStore.append({
        level: "WARN",
        message: "转码期间修改过设置，下次开始时会自动重新扫描",
        timestamp: new Date().toLocaleTimeString(),
      })
    }
    if (window.api?.notify) {
      void window.api.notify(
        failedCount > 0 ? "转码任务结束（含失败）" : "转码任务完成",
        `共处理 ${total} 个文件，成功 ${succeeded} 个${failedCount > 0 ? `，失败 ${failedCount} 个` : ""}`
      ).catch(() => undefined)
    }
  }
}

// Right toolbar stats
const tbStatsText = computed(() => {
  if (planStore.tasks.length === 0) return "暂无任务"
  const count = planStore.tasks.length
  const size = formatSize(planStore.totalSize || planStore.planSnapshot?.totalSize || 0)
  const duration = formatDuration(planStore.totalDuration || planStore.planSnapshot?.totalDuration || 0)
  if (planStore.hasStaged) {
    return `${count} 个文件（${planStore.stagedCount} 个待扫描）· ${size} · ${duration}`
  }
  return `${count} 个任务 · ${size} · ${duration}`
})

/**
 * 运行中/规划中/终止中的状态守卫。
 * 菜单加速键由主进程直接派发，绕过页面 keydown 拦截，
 * 因此守卫必须落在动作函数本身，而不能只写在 keydown 里。
 */
function isBusy() {
  return planStore.status === "RUNNING" || planStore.status === "PLANNING" || planStore.status === "STOPPING"
}

async function createPlanInternal() {
  if (configStore.inputs.length === 0) {
    throw new Error("请先添加至少一个媒体文件或目录")
  }
  // 「转码后删除源文件」的确认由**主进程**弹原生对话框完成。
  // 渲染层只表达意图（deleteSourceFiles），不再自行 confirm 也不回传确认位 ——
  // 否则这道不可撤销操作的安全门由信任度最低的一方自行声明通过。
  // 用户在原生框点「取消」时主进程会抛「用户取消了删除源文件确认」，
  // 由 createPlan 的 catch 识别为正常取消（不是失败）。
  if (configStore.inputs.length === 0) {
    throw new Error("请先添加至少一个媒体文件或目录")
  }

  planStore.status = "PLANNING"
  const effectiveInputs = planStore.excludedPaths.size > 0
    ? configStore.inputs.filter((p) => !planStore.excludedPaths.has(p))
    : [...configStore.inputs]

  if (effectiveInputs.length === 0) {
    throw new Error("没有有效的待转码输入文件")
  }

  const payload = JSON.parse(JSON.stringify({
    inputs: effectiveInputs,
    output: configStore.outputDir || undefined,
    preset: configStore.preset,
    options: {
      outputMode: configStore.outputMode,
      prefix: configStore.prefix || undefined,
      suffix: configStore.suffix || undefined,
      fps: configStore.tune.fps > 0 ? configStore.tune.fps : undefined,
      speed: configStore.tune.speed > 0 ? configStore.tune.speed : undefined,
      dimension: configStore.tune.dimension > 0 ? configStore.tune.dimension : undefined,
      videoBitrate: configStore.tune.bitrate.trim() || undefined,
      videoQuality: configStore.tune.quality > 0 ? configStore.tune.quality : undefined,
      audioCodec: configStore.tune.audioCodec || undefined,
      audioBitrate: configStore.tune.audioBitrate || undefined,
      hwaccel: configStore.adv.hwaccel !== "auto" ? configStore.adv.hwaccel : undefined,
      decodeMode: configStore.adv.decodeMode !== "auto" ? configStore.adv.decodeMode : undefined,
      jobs: configStore.adv.jobs > 1 ? configStore.adv.jobs : undefined,
      override: configStore.adv.override,
      anime: configStore.adv.anime,
      strict: configStore.adv.strict,
      deleteSourceFiles: configStore.adv.deleteSource,
    },
  }))
  const plan = await window.api.createPlan(payload)
  planStore.setPlan(plan)
  logStore.append({
    level: "INFO",
    message: `扫描完成：${plan.totalTasks} 个任务，预计 ${plan.totalDuration.toFixed(1)} 秒`,
    timestamp: new Date().toLocaleTimeString(),
  })
}

// Create / Update plan
async function createPlan() {
  if (isBusy()) return
  if (configStore.inputs.length === 0) {
    toast.push("请先添加至少一个媒体文件或目录", "warn")
    return
  }
  const knownPreviousPaths = new Set(planStore.tasks.map((t) => t.path))
  const selectedPaths = new Set(
    planStore.tasks.filter((t) => planStore.selectedIds.has(t.id)).map((t) => t.path)
  )

  try {
    await createPlanInternal()
    planStore.restoreSelectionByPaths(knownPreviousPaths, selectedPaths)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    // 用户在原生确认框点了「取消」是**正常取消**，不是失败：
    // 不能把状态打成 FAILED（红色「异常」标签）并弹出「生成计划失败」。
    if (msg.includes("取消了删除源文件确认")) {
      planStore.status = "READY"
      logStore.append({
        level: "INFO",
        message: "已取消，未启用「转码后删除源文件」",
        timestamp: new Date().toLocaleTimeString(),
      })
      return
    }
    planStore.status = "FAILED"
    toast.push(`扫描失败：${msg}`, "error")
    logStore.append({
      level: "ERROR",
      message: `扫描失败：${msg}`,
      timestamp: new Date().toLocaleTimeString(),
    })
  }
}

// Start execution
async function startExecution(options?: { dryRun?: boolean }) {
  // 入口自检：菜单 F5 与页面按钮共用此函数，无守卫会把运行中的会话打成 FAILED
  if (isBusy()) return
  if (planStore.tasks.length === 0 && configStore.inputs.length === 0) return

  // 1. 记忆当前用户明确勾选的文件绝对路径
  const knownPreviousPaths = new Set(planStore.tasks.map((t) => t.path))
  const selectedPaths = new Set(
    planStore.tasks.filter((t) => planStore.selectedIds.has(t.id)).map((t) => t.path)
  )

  // 2. 若存在未扫描的文件、设置已改动（STALE/hasStaged）或尚未扫描，隐式触发扫描。
  //    pendingStale：运行期间被改动的设置（运行中不能立刻标 STALE），也必须触发重新扫描，
  //    否则会复用主进程冻结的旧 argv，出现「配置已改、实际执行旧参数」。
  if (
    planStore.hasStaged ||
    planStore.status === "STALE" ||
    planStore.pendingStale ||
    !planStore.planSnapshot
  ) {
    try {
      await createPlanInternal()
      planStore.restoreSelectionByPaths(knownPreviousPaths, selectedPaths)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // 同 createPlan：取消高危确认是正常取消，不算失败
      if (msg.includes("取消了删除源文件确认")) {
        planStore.status = "READY"
        logStore.append({
          level: "INFO",
          message: "已取消：未启用「转码后删除源文件」，未开始转码。",
          timestamp: new Date().toLocaleTimeString(),
        })
        return
      }
      planStore.status = "FAILED"
      logStore.append({
        level: "ERROR",
        message: `准备失败：${msg}`,
        timestamp: new Date().toLocaleTimeString(),
      })
      return
    }
  }

  // 3. 显式提取选中的任务 ID，禁止传递空数组或 undefined
  const executableTasks = planStore.tasks.filter(
    (t) => planStore.selectedIds.has(t.id) && t.status !== "success" && t.status !== "skipped"
  )
  const executableIds = executableTasks.map((t) => t.id)
  if (executableIds.length === 0) {
    // 检查是否有失败项可供重试
    const failedTasks = planStore.tasks.filter((t) => t.status === "failed")
    if (failedTasks.length > 0) {
      for (const t of failedTasks) {
        planStore.selectedIds.add(t.id)
      }
      const retryIds = failedTasks.map((t) => t.id)
      if (configStore.adv.override) {
        logStore.append({
          level: "INFO",
          message: "已启用覆盖模式，同名输出文件会被直接重写",
          timestamp: new Date().toLocaleTimeString(),
        })
      }
      planStore.status = "RUNNING"
      try {
        await window.api.startExecution(retryIds, options)
        logStore.append({
          level: "INFO",
          message: options?.dryRun
            ? `重试前 10 帧测试（共 ${retryIds.length} 项）`
            : `重试失败转码任务（共 ${retryIds.length} 项）`,
          timestamp: new Date().toLocaleTimeString(),
        })
      } catch (error: unknown) {
        planStore.status = "FAILED"
        const msg = error instanceof Error ? error.message : String(error)
        logStore.append({
          level: "ERROR",
          message: `重试失败: ${msg}`,
          timestamp: new Date().toLocaleTimeString(),
        })
      }
      return
    }
    return
  }

  if (configStore.adv.override) {
    logStore.append({
      level: "INFO",
      message: "已启用覆盖模式，同名输出文件会被直接重写",
      timestamp: new Date().toLocaleTimeString(),
    })
  }

  planStore.status = "RUNNING"
  try {
    await window.api.startExecution(executableIds, options)
    logStore.append({
      level: "INFO",
      message: options?.dryRun
        ? `开始前 10 帧测试（共 ${executableIds.length} 项）`
        : `开始执行转码任务（共 ${executableIds.length} 项）`,
      timestamp: new Date().toLocaleTimeString(),
    })
  } catch (error: unknown) {
    planStore.status = "FAILED"
    const msg = error instanceof Error ? error.message : String(error)
    logStore.append({
      level: "ERROR",
      message: `执行失败: ${msg}`,
      timestamp: new Date().toLocaleTimeString(),
    })
  }
}

// Stop execution
async function stopExecution() {
  if (planStore.status !== "RUNNING" && planStore.status !== "STOPPING") return
  planStore.status = "STOPPING"
  try {
    await window.api.stopExecution()
    logStore.append({
      level: "WARN",
      message: "已请求停止，正在结束转码…",
      timestamp: new Date().toLocaleTimeString(),
    })
  } catch (error: unknown) {
    logStore.append({
      level: "ERROR",
      message: `停止失败：${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date().toLocaleTimeString(),
    })
  }
}

// Clear all tasks & inputs
async function clearAll() {
  if (isBusy()) return
  configStore.clearInputs()
  planStore.setPlan(null)
  if (window.api?.clearStagedInputs) {
    try {
      await window.api.clearStagedInputs()
    } catch (err) {
      console.error("clearStagedInputs error:", err)
    }
  }
}

let unsubscribeEvents: (() => void) | null = null
let unsubscribeMenu: (() => void) | null = null
let unsubscribeQueue: (() => void) | null = null

async function pickFilesGlobal() {
  try {
    const res = await window.api.selectFiles({ mode: "file", multiple: true })
    if (res.paths.length > 0) {
      await ingestPaths(res.paths)
    }
  } catch (err) {
    // 不能只 console.error：主进程对话框调用失败时用户点了「添加文件」界面毫无反应，
    // 日志抽屉里也查不到任何记录。只记日志等于没有反馈。
    console.error("pickFilesGlobal error:", err)
    logStore.append({
      level: "ERROR",
      message: `选择文件失败: ${err instanceof Error ? err.message : String(err)}`,
      timestamp: new Date().toLocaleTimeString(),
    })
  }
}

async function pickDirGlobal() {
  try {
    const res = await window.api.selectFiles({ mode: "directory" })
    if (res.paths.length > 0) {
      await ingestPaths(res.paths)
    }
  } catch (err) {
    console.error("pickDirGlobal error:", err)
    logStore.append({
      level: "ERROR",
      message: `选择目录失败: ${err instanceof Error ? err.message : String(err)}`,
      timestamp: new Date().toLocaleTimeString(),
    })
  }
}

function openOutputDir() {
  const dir = configStore.outputDir || (planStore.tasks[0]?.fileDst ? planStore.tasks[0].fileDst.replace(/[/\\][^/\\]+$/, "") : "")
  if (!dir) {
    logStore.append({
      level: "WARN",
      message: "尚未确定输出文件夹：请先扫描，或在左侧指定输出文件夹",
      timestamp: new Date().toLocaleTimeString(),
    })
    return
  }
  if (window.api?.openPath) {
    // 主进程对 SYSTEM_OPEN_PATH 做路径白名单校验，未授权路径会 reject。
    // 此前是 void 裸调用 → 用户看到「点了没反应」，控制台一条未处理拒绝。
    void window.api.openPath(dir).catch((err: unknown) => {
      logStore.append({
        level: "WARN",
        message: `打开输出目录失败: ${err instanceof Error ? err.message : String(err)}（${dir}）`,
        timestamp: new Date().toLocaleTimeString(),
      })
    })
  } else if (window.api?.showInFolder) {
    void Promise.resolve(window.api.showInFolder(dir)).catch(() => undefined)
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (showSettings.value) {
      showSettings.value = false
      return
    }
    if (showAbout.value) {
      showAbout.value = false
      return
    }
    if (logStore.drawerOpen) {
      logStore.drawerOpen = false
      return
    }
    if (planStore.inspectedTask) {
      planStore.inspectedTask = null
      return
    }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
    e.preventDefault()
    toggleSidebar()
  } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault()
    if (planStore.status !== "RUNNING" && planStore.status !== "PLANNING") {
      void createPlan()
    }
  }
}

/** 关闭/退出前尽力把待写盘的设置落盘（防抖窗口内关窗会丢最后一次改动） */
function handleBeforeUnload() {
  configStore.flushPersist()
}

onMounted(async () => {
  window.addEventListener("keydown", handleKeydown)
  window.addEventListener("resize", applyNarrowAutoCollapse)
  window.addEventListener("beforeunload", handleBeforeUnload)
  applyNarrowAutoCollapse()

  // 引擎事件 -> store 的唯一映射（订阅时机见下）
  function subscribeEngineEvents() {
    unsubscribeEvents = window.api.onEngineEvent(handleEngineEvent)
  }

  // ⚠️ 必须**第一个**订阅引擎事件，早于下面任何一个 await。
  // 此前订阅写在 onMounted 末尾，前面隔着 setCustomToolPaths / fetchEnv（内含
  // ffmpeg -version 与编码器探测，最慢的一步）/ getExecutionStatus 三个 await。
  // preload 的 onEngineEvent 只做 ipcRenderer.on，**没有缓冲或重放**，所以这段
  // 窗口内发出的一切事件（尤其 session.summary）会永久丢失：一旦丢失，
  // planStore.status 永远停在 RUNNING —— isBusy() 让「扫描」被静默 return、
  // 「开始转码」被禁用，用户只能点「终止」，而引擎其实早已结束。
  // 处理函数只依赖 planStore/logStore（模块级单例）与 window.api，提前订阅安全。
  subscribeEngineEvents()

  // Initialize theme: default to light
  const savedTheme = localStorage.getItem("mediac_theme") || "light"
  document.documentElement.setAttribute("data-theme", savedTheme)

  // Restore and sync custom external tool paths if saved in localStorage
  const savedFfmpeg = localStorage.getItem("mediac_tool_ffmpeg") || ""
  const savedFfprobe = localStorage.getItem("mediac_tool_ffprobe") || ""
  const savedMediainfo = localStorage.getItem("mediac_tool_mediainfo") || ""
  if (savedFfmpeg || savedFfprobe || savedMediainfo) {
    if (window.api?.setCustomToolPaths) {
      try {
        await window.api.setCustomToolPaths({
          ffmpeg: savedFfmpeg,
          ffprobe: savedFfprobe,
          mediainfo: savedMediainfo,
        })
      } catch (err) {
        console.error("Failed to restore custom tool paths:", err)
      }
    }
  }

  // 恢复持久化设置（预设/调参/高级选项/输出），必须在 fetchEnv 之前：
  // 下面的「预设是否仍然存在」校验要以已恢复的预设为基准
  await configStore.hydrate()

  // 恢复持久化队列（上次会话的输入清单与任务行）。必须在 configStore.hydrate
  // 之后：hydrate 会写 configStore.inputs，队列路径要在其基础上覆盖。
  // 恢复态一律「待扫描」，**绝不自动开始** —— argv/硬件方案需重新探测。
  if (window.api?.getQueue) {
    try {
      const snap = await window.api.getQueue()
      if (snap?.items?.length) {
        planStore.hydrateFromQueue(snap.items)
        configStore.setInputsFromQueue(snap.items.map((i) => i.path))
      }
    } catch (err) {
      console.error("Failed to restore queue:", err)
    }
  }

  // 先拿轻量预设目录：左侧面板（预设 / 视频 / 音频）立刻可用，
  // 不必等硬件探测（ffmpeg -version + 枚举编码器 + GPU 逐项探测，实测 1~2s）。
  await envStore.fetchPresets()
  if (envStore.presets.length > 0) {
    if (!envStore.presets.some((p) => p.name === configStore.preset)) {
      configStore.preset = envStore.presets[0].name
    }
  }
  // 硬件/系统信息后台补齐：状态栏与「关于」响应式填充，启动流程不等它
  void envStore.fetchEnv()

  // 恢复可能正在运行的执行状态 (A9)
  if (window.api?.getExecutionStatus) {
    try {
      const snap = await window.api.getExecutionStatus()
      if (snap?.isExecuting || snap?.status === "RUNNING" || snap?.status === "PLANNING" || snap?.status === "STOPPING") {
        if (snap.plan) {
          planStore.setPlan(snap.plan)
        }
        planStore.status = snap.status
        logStore.append({
          level: "INFO",
          message: `已恢复主进程活动任务状态 [${snap.status}]`,
          timestamp: new Date().toLocaleTimeString(),
        })
      }
    } catch (err) {
      console.error("Failed to restore execution status:", err)
    }
  }

  // Subscribe to system menu action events
  if (window.api?.onMenuAction) {
    unsubscribeMenu = window.api.onMenuAction((action: string) => {
      switch (action) {
        case MENU_ACTIONS.ADD_FILES:
          void pickFilesGlobal()
          break
        case MENU_ACTIONS.ADD_DIRECTORY:
          void pickDirGlobal()
          break
        case MENU_ACTIONS.OPEN_OUTPUT_DIR:
          openOutputDir()
          break
        case MENU_ACTIONS.CREATE_PLAN:
          void createPlan()
          break
        case MENU_ACTIONS.START_EXECUTION:
          void startExecution()
          break
        case MENU_ACTIONS.START_DRY_RUN:
          void startExecution({ dryRun: true })
          break
        case MENU_ACTIONS.STOP_EXECUTION:
          void stopExecution()
          break
        case MENU_ACTIONS.CLEAR_TASKS:
          clearAll()
          break
        case MENU_ACTIONS.TOGGLE_SIDEBAR:
          toggleSidebar()
          break
        case MENU_ACTIONS.TOGGLE_LOG:
          logStore.drawerOpen = !logStore.drawerOpen
          break
        case MENU_ACTIONS.TOGGLE_THEME: {
          const cur = document.documentElement.getAttribute("data-theme") || "light"
          const next = cur === "dark" ? "light" : "dark"
          document.documentElement.setAttribute("data-theme", next)
          localStorage.setItem("mediac_theme", next)
          break
        }
        case MENU_ACTIONS.OPEN_SETTINGS:
          showSettings.value = true
          break
      }
    })
  }

  // Subscribe to engine IPC events
  unsubscribeEvents = window.api.onEngineEvent(handleEngineEvent)

  /**
   * 队列变更广播订阅。
   *
   * 只镜像快照（供重排按钮做 path→queueId 映射），**不直接用队列刷新表格**：
   * ① 执行期主进程会按引擎事件高频回写队列状态，重放会覆盖正在被计划与事件驱动的表格；
   * ② 新入队文件的去重/勾选/解除排除由 addStagedTasks 统一处理，这里若抢先插入
   *    任务行，会让 addStagedTasks 因 path 已存在而跳过，遗留 excludedPaths 状态。
   */
  if (window.api?.onQueueChanged) {
    unsubscribeQueue = window.api.onQueueChanged((snapshot) => {
      planStore.setQueueItems(snapshot?.items)
    })
  }
})

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown)
  window.removeEventListener("resize", applyNarrowAutoCollapse)
  window.removeEventListener("beforeunload", handleBeforeUnload)
  unsubscribeEvents?.()
  unsubscribeMenu?.()
  unsubscribeQueue?.()
})
</script>

<template>
  <div class="app-container" data-testid="app-container">
    <!-- 全域拖拽高亮蒙层 -->
    <GlobalDropMask />

    <!-- 顶栏 HeaderBar -->
    <HeaderBar
      :stats-text="tbStatsText"
      :is-ingesting="isIngesting"
      @toggle-sidebar="toggleSidebar"
      @open-settings="showSettings = true"
      @create-plan="createPlan"
      @start-execution="startExecution"
      @stop-execution="stopExecution"
      @clear-all="clearAll"
    />

    <!-- 主工作区双栏布局 -->
    <div class="layout">
      <!-- 左侧配置侧栏 -->
      <aside
        class="side"
        :class="{ collapsed: isSidebarCollapsed }"
        :style="{ width: isSidebarCollapsed ? '0px' : `${sidebarWidth}px` }"
      >
        <ConfigPanel v-show="!isSidebarCollapsed" :is-busy="isBusy()" @collapse="toggleSidebar" />
      </aside>

      <!-- 拖拽手柄 -->
      <div
        v-show="!isSidebarCollapsed"
        class="side-resizer"
        :class="{ drag: isResizing }"
        data-testid="side-resizer"
        title="拖动调整左栏宽度"
        @mousedown="startResizing"
      ></div>

      <!-- 右侧主任务区 -->
      <main class="main" :class="{ 'with-edge-expand': isSidebarCollapsed }" data-testid="main-panel">
        <!-- 侧栏收起时的左边缘浮动展开按钮 -->
        <button
          v-if="isSidebarCollapsed"
          class="btn-edge-expand"
          data-testid="btn-edge-expand"
          title="展开转码配置栏 (Ctrl+B)"
          @click="toggleSidebar"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span>配置</span>
        </button>

        <!-- 表格或空态 -->
        <HeroEmpty v-if="planStore.tasks.length === 0" />
        <TaskTable v-else @clear-all="clearAll" />

        <!-- 底部紧凑/展开执行看板 -->
        <ExecutionBoard />
      </main>
    </div>

    <!-- 底部状态栏 StatusBar -->
    <StatusBar @open-about="showAbout = true" />

    <!-- 侧拉式右侧检查器抽屉 -->
    <TaskInspectorDrawer />

    <!-- 侧拉式右侧日志抽屉 -->
    <LogDrawer />

    <!-- 设置弹窗 -->
    <SettingsModal
      :show="showSettings"
      @close="showSettings = false"
    />

    <!-- 关于与系统信息弹窗 -->
    <AboutModal
      :show="showAbout"
      @close="showAbout = false"
    />

    <!-- 应用内操作提示（取代原生 alert） -->
    <ToastHost />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background-color: var(--bg-body);
  color: var(--text-base);
}

.layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.side {
  flex: none;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 10px;
  background: var(--bg-body);
  transition: width 0.16s ease, padding 0.16s ease;
}

.side.collapsed {
  width: 0 !important;
  padding: 0 !important;
  border-right: none;
}

.side-resizer {
  width: 5px;
  flex: none;
  cursor: col-resize;
  background: transparent;
  position: relative;
  z-index: 20;
}

.side-resizer::after {
  content: "";
  position: absolute;
  left: 2px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--divider);
}

.side-resizer:hover,
.side-resizer.drag {
  background: var(--primary-soft);
}

.side-resizer:hover::after,
.side-resizer.drag::after {
  background: var(--primary);
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-body);
  position: relative;
}

.btn-edge-expand {
  position: absolute;
  top: 12px;
  left: 0;
  z-index: 30;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-left: none;
  border-radius: 0 4px 4px 0;
  padding: 6px 6px;
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-2);
  cursor: pointer;
  box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
  transition: all 0.12s ease;
}

.btn-edge-expand:hover {
  background: var(--bg-hover);
  color: var(--primary-text);
  border-color: var(--border-strong);
}

.btn-edge-expand svg {
  width: 12px;
  height: 12px;
}

/*
 * 侧栏收起时，「展开配置」按钮是绝对定位在主区左上角的。
 * 它此前直接压在任务表的表头（复选框 / 源文件 列）上，把表头文字和列分隔线挡住；
 * 窄窗口自动折叠把这个现象变得很常见。
 * 现在为它预留出左侧内边距，让按钮落在**空白**里而不是盖住表头。
 */
.main.with-edge-expand {
  padding-left: 30px;
}

/*
 * 窄窗口下侧栏会自动收起，此时「配置」按钮常驻在主区左上角。
 * 带文字的按钮约 50px 宽，会盖住任务表最左侧的表头，因此窄屏只保留图标
 * （title 仍说明作用），把占位压到 30px 以内。
 */
@media (max-width: 1200px) {
  .btn-edge-expand span {
    display: none;
  }

  .btn-edge-expand {
    padding: 6px 4px;
  }

  .main.with-edge-expand {
    padding-left: 24px;
  }
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--divider);
  flex: none;
  flex-wrap: wrap;
  background: var(--bg-card);
}

.tb-left {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.tb-right {
  display: flex;
  gap: 14px;
  align-items: center;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

.muted {
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 11px;
}

.btn {
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  font-family: var(--font);
  border-radius: var(--radius);
  border: 1px solid transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-base);
  background: transparent;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  white-space: nowrap;
}

.btn:hover {
  background: var(--bg-hover);
}

.btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
  background: transparent;
}

.btn-primary {
  background: var(--primary);
  color: #101014;
  font-weight: 600;
}

.btn-primary:hover {
  background: var(--primary-hover);
}

.btn-primary:disabled {
  background: var(--primary);
  opacity: 0.38;
}

[data-theme="light"] .btn-primary {
  color: #fff;
}

.btn-secondary {
  border-color: var(--border);
  background: var(--bg-input);
}

.btn-secondary:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.btn-ghost {
  color: var(--text-2);
}

.btn-ghost:hover {
  background: var(--bg-hover);
  color: var(--text-base);
}

.btn-danger {
  color: var(--error);
  border-color: transparent;
}

.btn-danger:hover {
  background: var(--error-soft);
}

.btn-danger:disabled {
  opacity: 0.38;
  background: transparent;
}

.stale-alert {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 4px;
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 11px;
  font-weight: 500;
  animation: fadeIn 0.2s ease-out;
}

.stale-alert svg {
  width: 14px;
  height: 14px;
}

.pulse {
  animation: pulseAnim 1.8s infinite;
}

@keyframes pulseAnim {
  0% { box-shadow: 0 0 0 0 rgba(99, 226, 183, 0.4); }
  70% { box-shadow: 0 0 0 6px rgba(99, 226, 183, 0); }
  100% { box-shadow: 0 0 0 0 rgba(99, 226, 183, 0); }
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}

svg.i {
  width: 14px;
  height: 14px;
}

svg.i.sm {
  width: 13px;
  height: 13px;
}
</style>
