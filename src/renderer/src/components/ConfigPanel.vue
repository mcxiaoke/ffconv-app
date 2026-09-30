<script setup lang="ts">
import { ref, computed, watch } from "vue"
import { useConfigStore } from "../stores/config"
import { usePlanStore } from "../stores/plan"
import { useEnvStore } from "../stores/env"
import { useLogStore } from "../stores/log"
import { useInputIngest } from "../composables/useInputIngest"
import type { EnvironmentSummary } from "../../../shared/contracts"

/** 环境摘要里的预设条目形状（来自 shared/contracts，避免在此重复声明字段） */
type PresetSummary = EnvironmentSummary["presets"][number]

defineProps<{
  isBusy?: boolean
}>()

const emit = defineEmits<{
  (e: "collapse"): void
}>()

const config = useConfigStore()
const plan = usePlanStore()
const env = useEnvStore()
const logStore = useLogStore()
const { ingestPaths } = useInputIngest()

function formatPresetOption(p: PresetSummary): string {
  const parts: string[] = []
  if (p.type === "audio") {
    parts.push(p.audioCodec ? p.audioCodec.toUpperCase() : "AUDIO")
    if (p.audioBitrate) {
      const br = p.audioBitrate >= 1000 ? Math.round(p.audioBitrate / 1000) : p.audioBitrate
      parts.push(`${br}k`)
    }
    if (p.format) parts.push(p.format)
    return `${p.name} [${parts.join(" · ")}]`
  }
  // video
  if (p.videoCodecFamily) parts.push(p.videoCodecFamily.toUpperCase())
  if (p.dimension) parts.push(`${p.dimension}p`)
  if (p.videoQuality) parts.push(`CRF${p.videoQuality}`)
  else if (p.videoBitrate) {
    const br = p.videoBitrate >= 1000 ? Math.round(p.videoBitrate / 1000) : p.videoBitrate
    parts.push(`${br}k`)
  }
  if (p.audioCodec || p.audioBitrate) {
    const br = p.audioBitrate ? (p.audioBitrate >= 1000 ? Math.round(p.audioBitrate / 1000) : p.audioBitrate) : null
    const a = [p.audioCodec?.toUpperCase(), br ? `${br}k` : ""].filter(Boolean).join(" ")
    if (a) parts.push(a)
  }
  return `${p.name} [${parts.join(" · ")}]`
}

// Accordion collapse state
const isVideoOpen = ref(false)
const isAudioOpen = ref(false)

// Manual input text
const manualPathInput = ref("")

// Watch for changes to mark plan STALE
watch(
  [
    () => config.preset,
    () => config.outputDir,
    () => config.outputMode,
    () => config.prefix,
    () => config.suffix,
    () => config.tune,
    () => config.adv,
  ],
  () => {
    plan.markStale()
  },
  { deep: true }
)

// Watch inputs array: if empty -> IDLE
watch(
  () => config.inputs.length,
  (len) => {
    if (len === 0) {
      plan.setPlan(null)
    } else {
      plan.markStale()
    }
  }
)

// Watch preset & tune parameters to record live audit logs
watch(
  () => config.preset,
  (newPreset, oldPreset) => {
    if (newPreset && oldPreset && newPreset !== oldPreset) {
      logStore.append({
        level: "INFO",
        message: `转码预设已切换: ${oldPreset} → ${newPreset}`,
        timestamp: new Date().toLocaleTimeString(),
      })
    }
  }
)

watch(
  () => config.tune.dimension,
  (newVal, oldVal) => {
    if (newVal !== undefined && oldVal !== undefined && newVal !== oldVal) {
      logStore.append({
        level: "DEBUG",
        message: `修改视频分辨率: ${newVal === 0 ? "保持源分辨率" : newVal + "p"}`,
        timestamp: new Date().toLocaleTimeString(),
      })
    }
  }
)

watch(
  () => config.tune.quality,
  (newVal, oldVal) => {
    if (newVal !== undefined && oldVal !== undefined && newVal !== oldVal) {
      logStore.append({
        level: "DEBUG",
        message: `修改视频质量 CRF: ${newVal === 0 ? "与预设相同" : newVal}`,
        timestamp: new Date().toLocaleTimeString(),
      })
    }
  }
)

watch(
  () => config.tune.bitrate,
  (newVal, oldVal) => {
    if (newVal !== undefined && oldVal !== undefined && newVal !== oldVal) {
      logStore.append({
        level: "DEBUG",
        message: `修改视频码率: ${newVal || "与预设相同"}`,
        timestamp: new Date().toLocaleTimeString(),
      })
    }
  }
)

watch(
  () => config.tune.audioCodec,
  (newVal, oldVal) => {
    if (newVal !== undefined && oldVal !== undefined && newVal !== oldVal) {
      logStore.append({
        level: "DEBUG",
        message: `修改音频编码: ${newVal || "与预设相同"}`,
        timestamp: new Date().toLocaleTimeString(),
      })
    }
  }
)

watch(
  () => config.tune.audioBitrate,
  (newVal, oldVal) => {
    if (newVal !== undefined && oldVal !== undefined && newVal !== oldVal) {
      logStore.append({
        level: "DEBUG",
        message: `修改音频码率: ${newVal || "与预设相同"}`,
        timestamp: new Date().toLocaleTimeString(),
      })
    }
  }
)

async function pickFiles() {
  try {
    const res = await window.api.selectFiles({ mode: "file", multiple: true })
    if (res.paths.length > 0) {
      logStore.append({
        level: "INFO",
        message: `已添加 ${res.paths.length} 个媒体文件`,
        timestamp: new Date().toLocaleTimeString(),
      })
      await ingestPaths(res.paths)
    }
  } catch (err) {
    console.error("selectFiles error:", err)
  }
}

async function pickDirectory() {
  try {
    const res = await window.api.selectFiles({ mode: "directory", multiple: false })
    if (res.paths.length > 0) {
      logStore.append({
        level: "INFO",
        message: `已添加媒体目录: ${res.paths.join(", ")}`,
        timestamp: new Date().toLocaleTimeString(),
      })
      await ingestPaths(res.paths)
    }
  } catch (err) {
    console.error("selectFiles directory error:", err)
  }
}

async function pickOutputDir() {
  try {
    const res = await window.api.selectFiles({ mode: "directory", multiple: false })
    if (res.paths.length > 0) {
      // 走 commitCustomOutputDir：这是「显式选定一个目录」，需要联动
      // savedCustomOutputDir 与「保存在源文件同级」勾选（与 TaskTable 的选择器一致）
      config.commitCustomOutputDir(res.paths[0])
      logStore.append({
        level: "INFO",
        message: `输出目录已设置为: ${res.paths[0]}`,
        timestamp: new Date().toLocaleTimeString(),
      })
    }
  } catch (err) {
    console.error("selectOutputDir error:", err)
  }
}

async function addManualPath() {
  const val = manualPathInput.value.trim()
  if (val) {
    manualPathInput.value = ""
    logStore.append({
      level: "INFO",
      message: `手动添加路径: ${val}`,
      timestamp: new Date().toLocaleTimeString(),
    })
    await ingestPaths([val])
  }
}

/**
 * 移除单个输入项（左侧 chip 的 ✕）。
 *
 * ⚠️ 必须与 useTaskSelection.removeSelectedTasks 一样同步三处状态：
 *   1) planStore —— 表格行；2) configStore.inputs —— chip 列表；
 *   3) 主进程 stagedEntries —— 否则同一文件再次导入会被判重静默丢弃。
 * 此前这里只改了 configStore，实测表现为：chip 从 2 个变 1 个，
 * 表格仍是 2 行、顶栏仍显示「开始转码 · 2」，被删掉的文件照样被转码。
 */
/**
 * 失焦时把 CRF 归一化到合法数值。
 *
 * ⚠️ v-model.number 对空串不会转成数字：Vue 的 looseToNumber("") 返回字符串 ""，
 * 于是 tune.quality 变成 ""（表示「跟随预设」）。但滑杆是 range 控件，
 * 拿到 "" 会被 HTML 的 value sanitization 落回 min/max 中点（25.5 → 显示 26），
 * 于是**滑杆显示 26、实际却是「跟随预设」**——用户看着 26 点开始转码，
 * 跑出来的却是预设 CRF。
 * 归一化为 0（= 不限制，跟随预设）后滑杆与实际值一致。
 */
function normalizeQuality() {
  const q = Number(config.tune.quality)
  if (!Number.isFinite(q)) {
    config.tune.quality = 0
    return
  }
  config.tune.quality = Math.max(0, Math.min(51, Math.round(q)))
}

function removeInput(idx: number) {
  const target = config.inputs[idx]
  if (!target) return
  if (plan.status === "RUNNING" || plan.status === "PLANNING" || plan.status === "STOPPING") {
    return
  }
  config.removeInput(idx)
  // 按路径找到对应任务行并移除（可能有多个任务指向同一路径）
  const matched = plan.tasks.filter((t) => t.path === target)
  for (const t of matched) {
    plan.removeTask(t.id)
  }
  if (window.api?.removeStagedInputs) {
    void window.api.removeStagedInputs([target]).catch((err: unknown) => {
      logStore.append({
        level: "WARN",
        message: `移除暂存输入失败: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toLocaleTimeString(),
      })
    })
  }
  logStore.append({
    level: "INFO",
    message: `已移除输入项: ${target}`,
    timestamp: new Date().toLocaleTimeString(),
  })
}

async function handleDrop(event: DragEvent) {
  event.preventDefault()
  const files = Array.from(event.dataTransfer?.files || [])
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
    logStore.append({
      level: "INFO",
      message: `拖拽添加了 ${paths.length} 项路径`,
      timestamp: new Date().toLocaleTimeString(),
    })
    await ingestPaths(paths)
  }
}

// Preset grouping & selection
const selectedPresetObj = computed(() => {
  return env.summary?.presets.find((p) => p.name === config.preset) || null
})

const presetGroups = computed(() => {
  const list = env.summary?.presets || []
  const groups: Record<string, typeof list> = {}
  for (const p of list) {
    const key = (p.type === "audio" ? "音频预设" : p.videoCodecFamily?.toUpperCase() || "通用视频")
    if (!groups[key]) groups[key] = []
    groups[key].push(p)
  }
  return groups
})

// Summaries
const videoSummary = computed(() => {
  const parts: string[] = []
  if (config.tune.dimension > 0) parts.push(`${config.tune.dimension}p`)
  else if (selectedPresetObj.value?.dimension) parts.push(`${selectedPresetObj.value.dimension}p`)

  if (config.tune.quality > 0) parts.push(`CRF ${config.tune.quality}`)
  else if (selectedPresetObj.value?.videoQuality) parts.push(`CRF ${selectedPresetObj.value.videoQuality}`)

  if (config.tune.fps > 0) parts.push(`${config.tune.fps} fps`)
  if (config.tune.speed > 0) parts.push(`${config.tune.speed}x`)
  if (config.tune.bitrate) parts.push(config.tune.bitrate)

  return parts.length > 0 ? parts.join(" · ") : "默认"
})

const audioSummary = computed(() => {
  const parts: string[] = []
  if (config.tune.audioCodec) parts.push(config.tune.audioCodec)
  else if (selectedPresetObj.value?.audioCodec) parts.push(selectedPresetObj.value.audioCodec)

  if (config.tune.audioBitrate) parts.push(config.tune.audioBitrate)
  else if (selectedPresetObj.value?.audioBitrate) {
    const br = selectedPresetObj.value.audioBitrate
    const brStr = String(br).endsWith("k") ? String(br) : (Number(br) >= 1000 ? Math.round(Number(br) / 1000) + "k" : `${br}k`)
    parts.push(brStr)
  }

  return parts.length > 0 ? parts.join(" · ") : "默认"
})
</script>

<template>
  <aside class="side-panel" data-testid="config-panel">
    <!-- 侧栏顶部收起栏 -->
    <div class="side-top-bar">
      <div class="side-top-title">
        <svg class="side-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
        <span>转码设置</span>
      </div>
      <button
        class="side-collapse-btn"
        data-testid="btn-sidebar-collapse"
        title="隐藏转码设置 (Ctrl+B)"
        @click="emit('collapse')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        <span>隐藏</span>
      </button>
    </div>

    <div v-if="isBusy" class="busy-lock-banner" data-testid="busy-lock-banner">
      <svg class="i xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      <span>转码中，参数已锁定</span>
    </div>

    <!-- 1 文件与输出 -->
    <section class="card" data-testid="card-input-output">
      <div class="card-title">
        <span>文件与输出</span>
        <span class="sub">输入 / 输出位置 / 命名</span>
      </div>
      <div class="card-body">
        <div
          class="dropzone"
          tabindex="0"
          role="button"
          aria-label="拖放或点击选择文件夹"
          data-testid="side-dropzone"
          @dragover.prevent
          @drop.stop="handleDrop"
          @click="pickDirectory"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M3 16v2.5A2.5 2.5 0 0 0 5.5 21h13a2.5 2.5 0 0 0 2.5-2.5V16" />
            <path d="M12 3v13" />
            <path d="M7 8l5-5 5 5" />
          </svg>
          <span>拖放文件或文件夹到此处，点击可选择文件夹</span>
        </div>

        <div class="btn-row">
          <button class="btn btn-secondary" data-testid="btn-add-files" @click="pickFiles">
            <svg class="i sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            添加文件
          </button>
          <button class="btn btn-secondary" data-testid="btn-add-dir" @click="pickDirectory">
            <svg class="i sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            添加文件夹
          </button>
        </div>

        <div class="inline-row">
          <input
            v-model="manualPathInput"
            class="input grow"
            placeholder="粘贴文件或文件夹路径，回车添加"
            data-testid="input-manual-path"
            @keyup.enter="addManualPath"
          />
          <button class="btn btn-secondary" data-testid="btn-manual-add" @click="addManualPath">
            添加
          </button>
        </div>

        <!-- 输入路径清单 -->
        <div v-if="config.inputs.length > 0" class="chip-list" data-testid="chip-list">
          <div v-for="(item, idx) in config.inputs" :key="item" class="chip">
            <div class="chip-main">
              <div class="chip-name" :title="item">{{ item }}</div>
            </div>
            <button
              class="chip-x"
              title="移除"
              :data-testid="`btn-remove-input-${idx}`"
              @click="removeInput(idx)"
            >
              ✕
            </button>
          </div>
        </div>

        <div class="divider"></div>

        <div class="field">
          <label class="lbl">输出位置 <span class="hint">留空表示与源文件同目录</span></label>
          <div class="inline-row">
            <input
              :value="config.outputDir"
              class="input grow"
              placeholder="选择或输入输出文件夹"
              data-testid="input-output-dir"
              @input="config.setCustomOutputDir(($event.target as HTMLInputElement).value)"
              @change="config.commitCustomOutputDir(($event.target as HTMLInputElement).value)"
            />
            <button class="btn btn-secondary" data-testid="btn-select-output-dir" @click="pickOutputDir">
              选择文件夹
            </button>
          </div>
        </div>

        <div class="field">
          <label class="lbl">目录结构</label>
          <select v-model="config.outputMode" class="select" data-testid="select-output-mode">
            <option value="dir">保留上级文件夹名</option>
            <option value="tree">保留完整目录结构</option>
            <option value="file">全部输出到同一文件夹</option>
          </select>
        </div>

        <div class="field-row two">
          <div class="field">
            <label class="lbl">前缀</label>
            <input v-model="config.prefix" class="input" placeholder="[SHANA] " data-testid="input-prefix" />
          </div>
          <div class="field">
            <label class="lbl">后缀</label>
            <input v-model="config.suffix" class="input" placeholder="_{preset}" data-testid="input-suffix" />
          </div>
        </div>
      </div>
    </section>

    <!-- 2 预设 -->
    <section class="card" data-testid="card-preset">
      <div class="card-title">
        <span>预设</span>
        <span class="sub">决定输出编码与画质</span>
      </div>
      <div class="card-body">
        <div class="field">
          <select v-model="config.preset" class="select" data-testid="select-preset">
            <optgroup v-for="(presets, group) in presetGroups" :key="group" :label="group">
              <option v-for="p in presets" :key="p.name" :value="p.name">
                {{ formatPresetOption(p) }}
              </option>
            </optgroup>
          </select>

          <!-- 预设徽章 -->
          <div v-if="selectedPresetObj" class="preset-badges" data-testid="preset-badges">
            <span class="badge k">{{ selectedPresetObj.videoCodecFamily?.toUpperCase() || 'VIDEO' }}</span>
            <span v-if="selectedPresetObj.dimension" class="badge">
              {{ selectedPresetObj.dimension }}p
            </span>
            <span v-if="selectedPresetObj.videoQuality" class="badge">
              CRF {{ selectedPresetObj.videoQuality }}
            </span>
            <span v-if="selectedPresetObj.audioCodec" class="badge a">
              {{ selectedPresetObj.audioCodec }} {{ selectedPresetObj.audioBitrate ? (String(selectedPresetObj.audioBitrate).endsWith('k') ? selectedPresetObj.audioBitrate : (selectedPresetObj.audioBitrate >= 1000 ? Math.round(selectedPresetObj.audioBitrate / 1000) + 'k' : selectedPresetObj.audioBitrate + 'k')) : '' }}
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- 3 视频 -->
    <section class="card" data-testid="card-video">
      <div class="card-title toggle" @click="isVideoOpen = !isVideoOpen">
        <span class="title-with-sum">
          视频
          <span class="sum" data-testid="video-summary">{{ videoSummary }}</span>
        </span>
        <div class="title-right">
          <a
            v-if="config.videoDirtyCount > 0"
            class="reset-link"
            data-testid="btn-reset-video"
            title="恢复预设值"
            @click.stop="config.resetVideoTune()"
          >
            重置 ({{ config.videoDirtyCount }})
          </a>
          <svg class="chev i sm" :class="{ open: isVideoOpen }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      <div v-show="isVideoOpen" class="card-body" data-testid="video-body">
        <!-- 分辨率 -->
        <div class="field">
          <div class="field-label-row">
            <label class="lbl">
              分辨率 <span class="hint">按长边，不放大</span>
              <span v-if="config.isDimensionDirty" class="dot-dirty"></span>
            </label>
            <button
              v-if="config.isDimensionDirty"
              class="undo-btn"
              title="恢复预设值"
              @click="config.resetParam('dimension')"
            >
              ↺
            </button>
          </div>
          <div class="inline-row">
            <select v-model.number="config.tune.dimension" class="select grow" data-testid="select-dimension">
              <option :value="0">与源文件相同</option>
              <option :value="3840">3840 · 4K UHD</option>
              <option :value="2560">2560 · 2K QHD</option>
              <option :value="1920">1920 · 1080p FHD</option>
              <option :value="1280">1280 · 720p HD</option>
            </select>
            <input
              v-model.number="config.tune.dimension"
              class="input num"
              placeholder="像素"
              title="自定义长边像素"
              data-testid="input-dimension"
            />
          </div>
        </div>

        <!-- 视频质量 CRF -->
        <div class="field">
          <div class="field-label-row">
            <label class="lbl">
              质量 <span class="hint">CRF，0 表示与预设相同</span>
              <span v-if="config.isQualityDirty" class="dot-dirty"></span>
            </label>
            <button
              v-if="config.isQualityDirty"
              class="undo-btn"
              title="恢复预设值"
              @click="config.resetParam('quality')"
            >
              ↺
            </button>
          </div>
          <div class="quality-row">
            <input
              v-model.number="config.tune.quality"
              type="range"
              min="0"
              max="51"
              step="1"
              data-testid="slider-quality"
            />
            <input
              v-model.number="config.tune.quality"
              type="number"
              min="0"
              max="51"
              class="input num"
              data-testid="input-quality"
              @blur="normalizeQuality"
            />
          </div>
        </div>

        <!-- 视频码率 -->
        <div class="field">
          <div class="field-label-row">
            <label class="lbl">
              视频码率
              <span v-if="config.isBitrateDirty" class="dot-dirty"></span>
            </label>
            <button
              v-if="config.isBitrateDirty"
              class="undo-btn"
              title="恢复预设值"
              @click="config.resetParam('bitrate')"
            >
              ↺
            </button>
          </div>
          <div class="inline-row">
            <select v-model="config.tune.bitrate" class="select grow" data-testid="select-bitrate">
              <option value="">与预设相同</option>
              <option value="1500k">1500k</option>
              <option value="2500k">2500k</option>
              <option value="4M">4M</option>
              <option value="8M">8M</option>
              <option value="15M">15M</option>
            </select>
            <input
              v-model="config.tune.bitrate"
              class="input num"
              placeholder="k/M"
              title="自定义码率，如 3.5M"
              data-testid="input-bitrate"
            />
          </div>
        </div>

        <div class="field-row two">
          <!-- 帧率 -->
          <div class="field">
            <div class="field-label-row">
              <label class="lbl">
                帧率
                <span v-if="config.isFpsDirty" class="dot-dirty"></span>
              </label>
              <button
                v-if="config.isFpsDirty"
                class="undo-btn"
                title="恢复预设值"
                @click="config.resetParam('fps')"
              >
                ↺
              </button>
            </div>
            <select v-model.number="config.tune.fps" class="select" data-testid="select-fps">
              <option :value="0">与源文件相同</option>
              <option :value="23.976">23.976 fps</option>
              <option :value="24">24 fps（电影）</option>
              <option :value="25">25 fps（PAL）</option>
              <option :value="29.97">29.97 fps</option>
              <option :value="30">30 fps</option>
              <option :value="60">60 fps</option>
            </select>
          </div>

          <!-- 速度 -->
          <div class="field">
            <div class="field-label-row">
              <label class="lbl">
                速度 <span class="hint">0.5-2.0</span>
                <span v-if="config.isSpeedDirty" class="dot-dirty"></span>
              </label>
              <button
                v-if="config.isSpeedDirty"
                class="undo-btn"
                title="恢复预设值"
                @click="config.resetParam('speed')"
              >
                ↺
              </button>
            </div>
            <select v-model.number="config.tune.speed" class="select" data-testid="select-speed">
              <option :value="0">不变速</option>
              <option :value="0.5">0.5x</option>
              <option :value="0.75">0.75x</option>
              <option :value="1.25">1.25x</option>
              <option :value="1.5">1.5x</option>
              <option :value="2.0">2.0x</option>
            </select>
          </div>
        </div>
      </div>
    </section>

    <!-- 4 音频 -->
    <section class="card" data-testid="card-audio">
      <div class="card-title toggle" @click="isAudioOpen = !isAudioOpen">
        <span class="title-with-sum">
          音频
          <span class="sum" data-testid="audio-summary">{{ audioSummary }}</span>
        </span>
        <div class="title-right">
          <a
            v-if="config.audioDirtyCount > 0"
            class="reset-link"
            data-testid="btn-reset-audio"
            title="恢复预设值"
            @click.stop="config.resetAudioTune()"
          >
            重置 ({{ config.audioDirtyCount }})
          </a>
          <svg class="chev i sm" :class="{ open: isAudioOpen }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      <div v-show="isAudioOpen" class="card-body" data-testid="audio-body">
        <div class="field">
          <div class="field-label-row">
            <label class="lbl">
              编码
              <span v-if="config.isAudioCodecDirty" class="dot-dirty"></span>
            </label>
            <button
              v-if="config.isAudioCodecDirty"
              class="undo-btn"
              title="恢复预设值"
              @click="config.resetParam('audioCodec')"
            >
              ↺
            </button>
          </div>
          <select v-model="config.tune.audioCodec" class="select" data-testid="select-audio-codec">
            <option value="">与预设相同</option>
            <option value="copy">copy（不重编码）</option>
            <option value="aac">aac</option>
            <option value="libopus">libopus</option>
            <option value="mp3">mp3</option>
            <option value="flac">flac（无损）</option>
          </select>
        </div>

        <div class="field">
          <div class="field-label-row">
            <label class="lbl">
              码率
              <span v-if="config.isAudioBitrateDirty" class="dot-dirty"></span>
            </label>
            <button
              v-if="config.isAudioBitrateDirty"
              class="undo-btn"
              title="恢复预设值"
              @click="config.resetParam('audioBitrate')"
            >
              ↺
            </button>
          </div>
          <select v-model="config.tune.audioBitrate" class="select" data-testid="select-audio-bitrate">
            <option value="">与预设相同</option>
            <option value="48k">48k</option>
            <option value="64k">64k</option>
            <option value="96k">96k</option>
            <option value="128k">128k</option>
            <option value="192k">192k</option>
            <option value="256k">256k</option>
            <option value="320k">320k</option>
          </select>
        </div>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.side-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  height: 100%;
}

.side-top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  flex-shrink: 0;
}

.side-top-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-base);
}

.side-icon {
  width: 15px;
  height: 15px;
  color: var(--primary);
}

.side-collapse-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.side-collapse-btn:hover {
  background: var(--bg-hover);
  color: var(--text-base);
  border-color: var(--border-strong);
}

.side-collapse-btn svg {
  width: 12px;
  height: 12px;
}

.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  flex: none;
}

.card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid var(--divider);
}

.card-title .sub {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
}

.card-title.toggle {
  cursor: pointer;
  user-select: none;
  transition: background-color 0.12s;
}

.card-title.toggle:hover {
  background: var(--bg-hover);
}

.title-with-sum {
  display: flex;
  align-items: center;
  gap: 6px;
}

.title-with-sum .sum {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
  font-family: var(--mono);
}

.title-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.reset-link {
  font-size: 11px;
  color: var(--primary-text);
  cursor: pointer;
  text-decoration: underline;
}

.reset-link:hover {
  color: var(--primary-hover);
}

.chev {
  transition: transform 0.15s ease;
}

.chev.open {
  transform: rotate(180deg);
}

.card-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.divider {
  height: 1px;
  background: var(--divider);
  margin: 2px 0;
}

.dropzone {
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: 10px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  transition: border-color 0.15s, background-color 0.15s;
}

.dropzone:hover {
  border-color: var(--primary);
  color: var(--text-2);
}

.dropzone svg {
  width: 24px;
  height: 24px;
  opacity: 0.7;
}

.btn-row {
  display: flex;
  gap: 8px;
}

.btn-row > .btn {
  flex: 1;
  justify-content: center;
}

.inline-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.chip-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 140px;
  overflow-y: auto;
}

.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 12px;
}

.chip-main {
  flex: 1;
  min-width: 0;
}

.chip-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-2);
}

.chip-x {
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}

.chip-x:hover {
  background: var(--bg-hover);
  color: var(--error);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-row {
  display: flex;
  gap: 8px;
}

.field-row.two > .field {
  flex: 1;
}

.lbl {
  font-size: 12px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 4px;
}

.lbl.err {
  color: var(--error);
}

.hint {
  font-size: 11px;
  color: var(--text-3);
}

.dot-dirty {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary);
  display: inline-block;
}

.undo-btn {
  border: none;
  background: transparent;
  color: var(--primary-text);
  cursor: pointer;
  font-size: 12px;
  padding: 0 4px;
  font-weight: 700;
}

.undo-btn:hover {
  color: var(--primary-hover);
}

.input,
.select {
  height: 30px;
  padding: 0 8px;
  font-size: 12px;
  font-family: var(--font);
  color: var(--text-base);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  outline: none;
  transition: border-color 0.12s;
}

.select {
  cursor: pointer;
}

.select optgroup {
  background: var(--bg-card);
  color: var(--text-3);
}

.select option {
  background: var(--bg-card);
  color: var(--text-base);
}

.input:focus,
.select:focus {
  border-color: var(--primary);
}

.input.grow,
.select.grow {
  flex: 1;
  min-width: 0;
}

.input.num {
  width: 64px;
  text-align: center;
  font-family: var(--mono);
}

.btn {
  height: 30px;
  padding: 0 12px;
  font-size: 12px;
  font-family: var(--font);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-base);
  background: var(--bg-input);
  transition: background 0.12s, border-color 0.12s;
  white-space: nowrap;
}

.btn:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.preset-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 3px;
  font-size: 11px;
  background: var(--bg-active);
  color: var(--text-2);
  white-space: nowrap;
}

.badge.k {
  background: var(--primary-soft);
  color: var(--primary-text);
  font-weight: 600;
}

.badge.a {
  background: var(--info-soft);
  color: var(--info);
}

.quality-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quality-row input[type="range"] {
  flex: 1;
  accent-color: var(--primary);
  cursor: pointer;
}

.switches-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sw-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 0;
}

.sw {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--bg-active);
  border: 1px solid var(--border-strong);
  cursor: pointer;
  flex: none;
  transition: background 0.15s, border-color 0.15s;
}

.sw::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s;
}

.sw.on {
  background: var(--primary);
  border-color: var(--primary);
}

.sw.on::after {
  left: 18px;
}

.sw.err-sw.on {
  background: var(--error);
  border-color: var(--error);
}

svg.i {
  width: 14px;
  height: 14px;
}

svg.i.sm {
  width: 13px;
  height: 13px;
}

svg.i.xs {
  width: 12px;
  height: 12px;
}

.busy-lock-banner {
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 11px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
}
</style>
