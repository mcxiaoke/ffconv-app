<script setup lang="ts">
import { computed, ref, onUnmounted } from "vue"
import { usePlanStore } from "../stores/plan"
import { useConfigStore } from "../stores/config"
import { useLogStore } from "../stores/log"
import { useFocusTrap } from "../composables/useFocusTrap"
import { formatSize, formatDuration, highlightFfmpegCmd } from "../utils/format"

const plan = usePlanStore()
const config = useConfigStore()
const logStore = useLogStore()

const drawerRef = ref<HTMLElement | null>(null)
useFocusTrap(drawerRef, computed(() => !!plan.inspectedTask))

const task = computed(() => plan.inspectedTask)
const copiedCmd = ref(false)
const copiedRaw = ref(false)
const showRawMeta = ref(false)

/** 任务状态的中文标签（与 TaskTable 的 STATUS_MAP 同一套用词） */
const STATUS_TEXT: Record<string, string> = {
  staged: "待扫描",
  pending: "等待中",
  preparing: "准备中",
  running: "转码中",
  retrying: "重试中",
  success: "完成",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已停止",
}
const statusText = computed(() => STATUS_TEXT[task.value?.status || ""] || "等待中")

/**
 * 命令来源（三者都不是最终命令，差异来源须在 UI 上标注）：
 *  - "probe"    —— 用户**手动**点「实测」后，主进程对**本文件**真跑分层探测
 *                  （与执行期同一套 selectTier/probeLayer 干跑）得到的**实际**命令；
 *                  仅内存、不持久化，参数一改即随 STALE 失效；
 *  - "plan"     —— 扫描期由主进程按**能力级分层**生成的**预计**命令：走候选链
 *                  （resolvePreviewHwPlan）并复用 GPU 支持矩阵预筛，但不做逐文件
 *                  ffmpeg 干跑（`-frames:v ... -f null -`）。多数文件与真实执行一致；
 *                  个别文件（本身解不开、矩阵明确不支持、失败重试强制 cpu）可能降级，
 *                  故仍标注「预计」而非「实际」；
 *  - "estimate" —— 尚未扫描时，本组件按当前设置拼接的**预览**命令。
 */
const cmdSource = computed<"probe" | "plan" | "estimate">(() => {
  if (task.value?.probeCmd) return "probe"
  return plan.planSnapshot?.previewCmd ? "plan" : "estimate"
})

const cmdLabel = computed(() =>
  cmdSource.value === "probe" ? "实测" : cmdSource.value === "plan" ? "预计" : "预览"
)

// 实测：仅手动触发；扫描/转码进行中、音频任务或尚未扫描时不可用
const probing = ref(false)
const probeError = ref("")
const isBusy = computed(() =>
  ["RUNNING", "PLANNING", "STOPPING"].includes(plan.status)
)
const canProbe = computed(
  () => !!plan.planSnapshot && !probing.value && !isBusy.value && !!task.value?.videoCodec
)
const probeDisabledReason = computed(() => {
  if (!task.value?.videoCodec) return "音频任务不涉及视频分层，无需实测"
  if (isBusy.value) return "扫描或转码进行中，暂不可实测"
  if (!plan.planSnapshot) return "请先扫描后再实测"
  return ""
})

async function runProbe() {
  const t = task.value
  if (!t || !canProbe.value) return
  probing.value = true
  probeError.value = ""
  try {
    const res = await window.api.probeTask(t.id)
    plan.setProbeResult(res)
    if (res.audio) probeError.value = "音频任务不涉及视频分层"
  } catch (err) {
    probeError.value = err instanceof Error ? err.message : String(err)
    logStore.append({
      level: "ERROR",
      message: `实测本机命令失败：${probeError.value}`,
      timestamp: new Date().toLocaleTimeString(),
    })
  } finally {
    probing.value = false
  }
}

const cmdString = computed(() => {
  if (!task.value) return ""
  // 实测结果优先：它已按本任务的输出路径生成，无需再做路径替换
  if (task.value.probeCmd) return task.value.probeCmd
  if (plan.planSnapshot?.previewCmd) {
    // 统一走 store：按 path 反查基准任务，避免移除过首行后替换失配
    return plan.previewCmdFor(task.value)
  }

  // 动态根据当前配置与预设生成推演命令预览
  const presetLower = (config.preset || "").toLowerCase()
  let vcodec = "libx264"
  let defaultCrf = "23"

  if (presetLower.includes("hevc") || presetLower.includes("h265") || presetLower.includes("x265") || presetLower.includes("265")) {
    vcodec = "libx265"
    defaultCrf = "28"
  } else if (presetLower.includes("av1") || presetLower.includes("svtav1")) {
    vcodec = "libsvtav1"
    defaultCrf = "30"
  } else if (presetLower.includes("vp9")) {
    vcodec = "libvpx-vp9"
    defaultCrf = "30"
  } else if (presetLower.includes("copy")) {
    vcodec = "copy"
  }

  const parts: string[] = ["ffmpeg", "-hide_banner", "-i", `"${task.value.path}"`]

  if (vcodec === "copy") {
    parts.push("-c:v", "copy")
  } else {
    parts.push("-c:v", vcodec)
    if (config.tune.bitrate.trim()) {
      parts.push("-b:v", config.tune.bitrate.trim())
    } else {
      parts.push("-crf", config.tune.quality > 0 ? String(config.tune.quality) : defaultCrf)
    }
  }

  if (config.tune.fps > 0) {
    parts.push("-r", String(config.tune.fps))
  }
  if (config.tune.dimension > 0) {
    parts.push("-vf", `"scale=-2:${config.tune.dimension}"`)
  }

  const acodec = config.tune.audioCodec || "aac"
  parts.push("-c:a", acodec)
  if (acodec !== "copy") {
    parts.push("-b:a", config.tune.audioBitrate || "192k")
  }

  const outDst = task.value.fileDst || (task.value.path ? task.value.path.replace(/\.[^.]+$/, "_output.mp4") : "output.mp4")
  parts.push(`"${outDst}"`)

  return parts.join(" ")
})

const highlightedCmd = computed(() => {
  return highlightFfmpegCmd(cmdString.value)
})

const rawMetadataText = computed(() => {
  if (!task.value) return ""
  if (task.value.mediaInfo) {
    return JSON.stringify(task.value.mediaInfo, null, 2)
  }
  if (task.value.rawMetadata) return task.value.rawMetadata
  return JSON.stringify({
    name: task.value.name,
    path: task.value.path,
    size: task.value.size,
    duration: task.value.duration,
    videoCodec: task.value.videoCodec,
    profile: task.value.profile,
    level: task.value.level,
    width: task.value.width,
    height: task.value.height,
    aspectRatio: task.value.aspectRatio,
    fps: task.value.fps,
    pixelFormat: task.value.pixelFormat,
    bitDepth: task.value.bitDepth,
    audioCodec: task.value.audioCodec,
    audioChannels: task.value.audioChannels,
    audioSampleRate: task.value.audioSampleRate,
    audioBitrate: task.value.audioBitrate
  }, null, 2)
})

function close() {
  plan.inspectedTask = null
}

/**
 * 复制到剪贴板，并据实际结果反馈。
 *
 * ⚠️ 此前无论成功与否都设 `copied = true`，复制失败时按钮照样显示「已复制」。
 * 现在主进程返回布尔值，失败时给出错误提示而不是假装成功。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (window.api?.copyText) {
      const ok = await window.api.copyText(text)
      if (ok === false) return false
      return true
    }
    await navigator.clipboard.writeText(text)
    return true
  } catch (err) {
    console.error("Clipboard copy failed:", err)
    return false
  }
}

async function copyCmd() {
  if (!cmdString.value) return
  if (!(await copyToClipboard(cmdString.value))) {
    logStore.append({
      level: "ERROR",
      message: "复制 FFmpeg 命令失败：剪贴板不可用",
      timestamp: new Date().toLocaleTimeString(),
    })
    return
  }
  copiedCmd.value = true
  setTimeout(() => { copiedCmd.value = false }, 2000)
}

async function copyRaw() {
  if (!rawMetadataText.value) return
  if (!(await copyToClipboard(rawMetadataText.value))) {
    logStore.append({
      level: "ERROR",
      message: "复制原始元数据失败：剪贴板不可用",
      timestamp: new Date().toLocaleTimeString(),
    })
    return
  }
  copiedRaw.value = true
  setTimeout(() => { copiedRaw.value = false }, 2000)
}

function locateFile() {
  if (task.value?.path) {
    void window.api.showInFolder(task.value.path).catch((err: unknown) => {
      logStore.append({
        level: "WARN",
        message: `在文件管理器中定位失败: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toLocaleTimeString(),
      })
    })
  }
}

// 默认 560px，支持读取上次拖拽偏好
const savedInspW = Number(localStorage.getItem("mediac_inspector_width"))
const drawerWidth = ref(savedInspW && savedInspW >= 420 ? savedInspW : 560)
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
    localStorage.setItem("mediac_inspector_width", String(drawerWidth.value))
    window.removeEventListener("mousemove", onMouseMove)
    window.removeEventListener("mouseup", stop)
    // 指针在窗口外松开时收不到 mouseup，监听与 isResizing 会常驻
    window.removeEventListener("blur", stop)
    stopResizing = null
  }

  stopResizing = stop
  window.addEventListener("mousemove", onMouseMove)
  window.addEventListener("mouseup", stop)
  window.addEventListener("blur", stop)
}

// 拖拽中组件被卸载时，window 监听必须兜底摘除
let stopResizing: (() => void) | null = null
onUnmounted(() => stopResizing?.())
</script>

<template>
  <div v-if="task" class="inspector-mask" data-testid="inspector-mask" @click="close">
    <aside
      ref="drawerRef"
      class="inspector-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="任务详情"
      tabindex="-1"
      :class="{ 'no-transition': isResizing }"
      :style="{ width: `${drawerWidth}px` }"
      @click.stop
    >
      <!-- 左边缘宽度拖拽手柄 -->
      <div
        class="drawer-resizer"
        :class="{ dragging: isResizing }"
        data-testid="inspector-drawer-resizer"
        title="拖动调整宽度"
        @mousedown.stop="startResizing"
      ></div>

      <div class="insp-head">
        <div class="insp-title-zone">
          <span class="insp-title" :title="task.name">{{ task.name }}</span>
          <span class="tag" :class="task.status">{{ statusText }}</span>
        </div>
        <button class="close-btn" data-testid="btn-close-inspector" title="关闭 (Esc)" @click="close">✕</button>
      </div>

      <div class="insp-body">
        <!-- 规格对比卡片 -->
        <div class="insp-card">
          <div class="insp-card-title">
            <span>媒体信息</span>
            <span v-if="task.bitDepth && task.bitDepth > 8" class="tag ok">{{ task.bitDepth }}bit HDR/Wide</span>
            <span v-else class="tag ok">已读取</span>
          </div>
          <div class="insp-grid">
            <div class="insp-kv">
              <span class="k">视频编码</span>
              <span class="v">{{ (task.videoCodec || "未知").toUpperCase() }} {{ task.profile ? `(${task.profile}${task.level ? '@' + task.level : ''})` : '' }}</span>
            </div>
            <div class="insp-kv">
              <span class="k">输出预设</span>
              <span class="v primary-text">{{ plan.planSnapshot?.presetName || config.preset.toUpperCase() }}</span>
            </div>
            <div class="insp-kv">
              <span class="k">分辨率 / 宽高比</span>
              <span class="v">{{ task.width && task.height ? `${task.width}×${task.height}` : '—' }} {{ task.aspectRatio ? `(${task.aspectRatio})` : '' }}</span>
            </div>
            <div class="insp-kv">
              <span class="k">帧率 / 像素格式</span>
              <span class="v">{{ task.fps ? `${task.fps} fps` : '—' }} · {{ task.pixelFormat || '—' }}</span>
            </div>
            <div class="insp-kv">
              <span class="k">大小 / 时长</span>
              <span class="v">{{ formatSize(task.size) }} ({{ formatDuration(task.duration) }})</span>
            </div>
            <div class="insp-kv">
              <span class="k">位深</span>
              <span class="v">{{ task.bitDepth ? `${task.bitDepth} bit` : '8 bit' }}</span>
            </div>
            <div class="insp-kv">
              <span class="k">音频</span>
              <span class="v">{{ task.audioCodec ? task.audioCodec.toUpperCase() : '无音频' }} {{ task.audioChannels ? `· ${task.audioChannels}声道` : '' }} {{ task.audioSampleRate ? `· ${task.audioSampleRate}Hz` : '' }}</span>
            </div>
            <div class="insp-kv">
              <span class="k">输出音频</span>
              <span class="v">{{ config.tune.audioCodec || "aac" }} · {{ config.tune.audioBitrate || "192k" }}</span>
            </div>
          </div>
        </div>

        <!-- 原始元数据 (纯文本 / JSON) 卡片 -->
        <div class="insp-card">
          <div class="insp-card-title">
            <span>原始元数据（ffprobe）</span>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-sm" data-testid="btn-toggle-raw-meta" @click="showRawMeta = !showRawMeta">
                {{ showRawMeta ? '收起' : '展开' }}
              </button>
              <button class="btn btn-sm" data-testid="btn-copy-raw-meta" @click="copyRaw">
                {{ copiedRaw ? '已复制' : '复制' }}
              </button>
            </div>
          </div>
          <div v-show="showRawMeta" class="raw-meta-box" data-testid="insp-raw-meta-box">
            <pre class="raw-meta-pre">{{ rawMetadataText }}</pre>
          </div>
        </div>

        <!-- FFmpeg 命令行推演卡片 -->
        <div class="insp-card">
          <div class="insp-card-title">
            <span>FFmpeg 命令（{{ cmdLabel }}）</span>
            <div class="cmd-actions">
              <button
                class="btn btn-sm"
                data-testid="btn-probe-cmd"
                :disabled="!canProbe"
                :title="probeDisabledReason"
                @click="runProbe"
              >
                {{ probing ? '实测中…' : '实测' }}
              </button>
              <button class="btn btn-sm" data-testid="btn-copy-cmd" @click="copyCmd">
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                {{ copiedCmd ? '已复制' : '复制' }}
              </button>
            </div>
          </div>
          <div v-if="cmdSource === 'probe'" class="cmd-warn" data-testid="cmd-probe-warn">
            实测命令（本机探测）：已对本文件真跑分层探测，命中层「{{ task.probeTier }}」{{ task.probeDegraded ? '（有降级）' : '' }}，与真实执行使用同一套分层决策。试跑只解码前若干帧、不产出文件。
          </div>
          <div v-else-if="cmdSource === 'plan'" class="cmd-warn" data-testid="cmd-plan-warn">
            预计命令：按本机硬件能力推断的分层（已套用 GPU 支持矩阵预筛），未对文件逐个干跑探测。真实执行时该文件若解不开或失败重试，可能降级为软件编码。可点「实测」对当前文件真跑一次探测。
          </div>
          <div v-else class="cmd-warn" data-testid="cmd-estimate-warn">
            尚未扫描：这里按当前设置预览，与执行时按文件探测得出的命令无关。点击「扫描」后可看到按本机能力推断的预计命令。
          </div>
          <div v-if="probeError" class="cmd-warn error" data-testid="cmd-probe-error">{{ probeError }}</div>
          <div class="cmd-box" data-testid="insp-cmd-box" v-html="highlightedCmd"></div>
        </div>

        <!-- 路径卡片 -->
        <div class="insp-card">
          <div class="insp-card-title">
            <span>路径</span>
            <button class="btn btn-sm" @click="locateFile">在文件夹中显示</button>
          </div>
          <div class="paths-box">
            <div class="path-item">
              <span class="path-label">源文件</span>
              <span class="path-val">{{ task.path }}</span>
            </div>
            <div class="path-item">
              <span class="path-label">输出文件</span>
              <span class="path-val primary-text">{{ task.fileDst }}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.inspector-mask {
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

.inspector-drawer {
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

.inspector-drawer.no-transition {
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

.insp-head {
  height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.insp-title-zone {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

.insp-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-base);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}

.tag {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: var(--radius);
  background: var(--bg-hover);
  color: var(--text-2);
}
.tag.ok { background: var(--primary-soft); color: var(--primary-text); }
.tag.running { background: var(--info-soft); color: var(--info); }
.tag.failed { background: var(--error-soft); color: var(--error); }

.close-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--radius);
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-base);
}

.insp-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.insp-card {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.insp-card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-base);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.insp-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
}

.insp-kv {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.insp-kv .k {
  font-size: 11px;
  color: var(--text-3);
}

.insp-kv .v {
  font-size: 12px;
  color: var(--text-base);
  word-break: break-all;
}

.primary-text {
  color: var(--primary-text) !important;
}

.btn {
  height: 24px;
  padding: 0 8px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-2);
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.btn:hover {
  background: var(--bg-hover);
  color: var(--text-base);
  border-color: var(--border-strong);
}

.btn-icon {
  width: 12px;
  height: 12px;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cmd-actions {
  display: flex;
  gap: 6px;
}

.cmd-warn {
  background: var(--warning-soft);
  color: var(--warning);
  border: 1px solid rgba(242, 201, 125, 0.35);
  border-radius: var(--radius);
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.5;
}

.cmd-warn.error {
  background: var(--error-soft);
  color: var(--error);
  border-color: rgba(248, 81, 73, 0.35);
}

.cmd-box {
  background: #0d1117;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
  color: #e6edf3;
  word-break: break-all;
  white-space: pre-wrap;
  max-height: 220px;
  overflow-y: auto;
}

:deep(.fl) {
  color: #7ee787;
  font-weight: 600;
}

:deep(.path) {
  color: #79c0ff;
}

.paths-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
}

.path-item {
  word-break: break-all;
}

.path-label {
  color: var(--text-3);
  /* 标签与长路径之间需要视觉分隔，否则两者会连成一串 */
  flex: none;
  margin-right: 8px;
}

.raw-meta-box {
  background: #0d1117;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 8px 10px;
  max-height: 240px;
  overflow-y: auto;
  user-select: text;
}

.raw-meta-pre {
  margin: 0;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
  color: #c9d1d9;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
</style>
