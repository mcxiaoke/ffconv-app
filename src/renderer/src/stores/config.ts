import { defineStore } from "pinia"
import { ref, computed, watch, nextTick } from "vue"
import type { AppSettings } from "../../../shared/contracts"

export interface TuneConfig {
  dimension: number
  quality: number
  bitrate: string
  fps: number
  speed: number
  audioCodec: string
  audioBitrate: string
}

export interface AdvConfig {
  hwaccel: string
  decodeMode: string
  jobs: number
  override: boolean
  anime: boolean
  strict: boolean
  deleteSource: boolean
}

export const useConfigStore = defineStore("config", () => {
  const inputs = ref<string[]>([])
  const outputDir = ref("")
  const outputBesideSource = ref(!outputDir.value)
  const savedCustomOutputDir = ref(outputDir.value || "")
  const outputMode = ref<"tree" | "dir" | "file">("dir")
  const prefix = ref("")
  const suffix = ref("")
  const preset = ref("hevc_2k")

  function setOutputBesideSource(val: boolean) {
    outputBesideSource.value = val
    if (val) {
      if (outputDir.value) {
        savedCustomOutputDir.value = outputDir.value
      }
      outputDir.value = ""
    } else {
      outputDir.value = savedCustomOutputDir.value || ""
    }
  }

  /**
   * 自定义输出目录输入框的逐字符输入。
   *
   * ⚠️ 绝不能在这里联动 `outputBesideSource`：调用方用 `v-if="!outputBesideSource"`
   * 决定是否渲染该输入框，用户退格删到最后一个字符时 dir 变空 →
   * outputBesideSource 被置回 true → 输入框连同「更改…」按钮当场卸载，
   * 焦点丢失、光标跳走，且用户看不到自己刚改了什么（框已经消失）。
   * 另：逐字符写入还会把半截路径存进 savedCustomOutputDir。
   * 「同级 / 自定义」的选择只应由显式的勾选框或「选择目录」按钮驱动。
   */
  function setCustomOutputDir(dir: string) {
    outputDir.value = dir
  }

  /** 「选择目录」按钮 / 手动敲完整路径后的显式提交（会联动「同级」勾选） */
  function commitCustomOutputDir(dir: string) {
    const v = dir.trim()
    outputDir.value = v
    savedCustomOutputDir.value = v
    outputBesideSource.value = !v
  }

  const tune = ref<TuneConfig>({
    dimension: 0,
    quality: 0,
    bitrate: "",
    fps: 0,
    speed: 0,
    audioCodec: "",
    audioBitrate: "",
  })

  const adv = ref<AdvConfig>({
    hwaccel: "auto",
    decodeMode: "auto",
    jobs: 1,
    override: false,
    anime: false,
    strict: false,
    deleteSource: false,
  })

  // Dirty indicators for video/audio tune
  const isDimensionDirty = computed(() => tune.value.dimension !== 0)
  const isQualityDirty = computed(() => tune.value.quality !== 0)
  const isBitrateDirty = computed(() => tune.value.bitrate !== "")
  const isFpsDirty = computed(() => tune.value.fps !== 0)
  const isSpeedDirty = computed(() => tune.value.speed !== 0)
  const isAudioCodecDirty = computed(() => tune.value.audioCodec !== "")
  const isAudioBitrateDirty = computed(() => tune.value.audioBitrate !== "")

  const videoDirtyCount = computed(() => {
    return (
      (isDimensionDirty.value ? 1 : 0) +
      (isQualityDirty.value ? 1 : 0) +
      (isBitrateDirty.value ? 1 : 0) +
      (isFpsDirty.value ? 1 : 0) +
      (isSpeedDirty.value ? 1 : 0)
    )
  })

  const audioDirtyCount = computed(() => {
    return (
      (isAudioCodecDirty.value ? 1 : 0) +
      (isAudioBitrateDirty.value ? 1 : 0)
    )
  })

  function resetParam(key: keyof TuneConfig) {
    if (key === "dimension" || key === "quality" || key === "fps" || key === "speed") {
      tune.value[key] = 0
    } else {
      tune.value[key] = ""
    }
  }

  function resetVideoTune() {
    tune.value.dimension = 0
    tune.value.quality = 0
    tune.value.bitrate = ""
    tune.value.fps = 0
    tune.value.speed = 0
  }

  function resetAudioTune() {
    tune.value.audioCodec = ""
    tune.value.audioBitrate = ""
  }

  // ===== 「文件与输出」的脏值与重置 =====
  // 视频/音频有「恢复预设值」可依，这一组没有预设参与，对应的基准是默认值：
  // 输出到源文件同级、保留上级文件夹名、无前后缀。

  const isOutputDirDirty = computed(() => outputDir.value !== "" || !outputBesideSource.value)
  const isOutputModeDirty = computed(() => outputMode.value !== "dir")
  const isPrefixDirty = computed(() => prefix.value !== "")
  const isSuffixDirty = computed(() => suffix.value !== "")

  const outputDirtyCount = computed(
    () =>
      (isOutputDirDirty.value ? 1 : 0) +
      (isOutputModeDirty.value ? 1 : 0) +
      (isPrefixDirty.value ? 1 : 0) +
      (isSuffixDirty.value ? 1 : 0),
  )

  /**
   * 恢复「文件与输出」的默认值。
   *
   * 刻意不动的两项：
   * - `inputs`：那是用户挑的素材，不是参数；清空属于误操作成本极高的一类。
   * - `savedCustomOutputDir`：它是「上次用过的自定义目录」的记忆，
   *   保留它，用户取消勾选「与源文件同级」时还能拿回来。
   */
  function resetOutputSettings() {
    outputDir.value = ""
    outputBesideSource.value = true
    outputMode.value = "dir"
    prefix.value = ""
    suffix.value = ""
  }

  function addInputs(paths: string[]) {
    const set = new Set([...inputs.value, ...paths.filter(Boolean)])
    inputs.value = Array.from(set)
  }

  function removeInput(index: number) {
    inputs.value.splice(index, 1)
  }

  function removeInputs(paths: string[]) {
    if (!paths || paths.length === 0) return
    const toRemove = new Set(paths)
    inputs.value = inputs.value.filter((p) => !toRemove.has(p))
  }

  function clearInputs() {
    inputs.value = []
  }

  // ===== 设置持久化 =====
  // 用户配置（预设/调参/高级选项/输出）此前只活在内存，每次启动复位。
  // 现在经 IPC 落 userData/settings.json，启动时水合恢复。

  /** 水合完成前不得回写，否则会用默认值覆盖磁盘 */
  const hydrated = ref(false)
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  /** 可持久化子集；刻意剔除 deleteSource（高危开关不跨会话继承） */
  function snapshotForPersist(): AppSettings {
    return {
      preset: preset.value,
      outputDir: outputDir.value,
      outputBesideSource: outputBesideSource.value,
      savedCustomOutputDir: savedCustomOutputDir.value,
      outputMode: outputMode.value,
      prefix: prefix.value,
      suffix: suffix.value,
      tune: { ...tune.value },
      adv: {
        hwaccel: adv.value.hwaccel,
        decodeMode: adv.value.decodeMode,
        jobs: adv.value.jobs,
        override: adv.value.override,
        anime: adv.value.anime,
        strict: adv.value.strict,
      },
    }
  }

  function applySettings(s: AppSettings) {
    preset.value = s.preset || preset.value
    outputMode.value = s.outputMode
    prefix.value = s.prefix
    suffix.value = s.suffix
    tune.value = { ...tune.value, ...s.tune }
    // adv 展开不含 deleteSource，故该字段保持当前（默认 false）不受恢复影响
    adv.value = { ...adv.value, ...s.adv }
    outputDir.value = s.outputDir
    savedCustomOutputDir.value = s.savedCustomOutputDir || s.outputDir
    outputBesideSource.value = s.outputBesideSource
  }

  /** 启动时恢复磁盘设置；waiting nextTick 是为了让本次赋值触发的 watcher 先跑完，
   *  避免水合产生的变更被当成用户操作回写一遍。 */
  async function hydrate(): Promise<void> {
    if (hydrated.value) return
    try {
      const saved = await window.api?.getSettings?.()
      if (saved) applySettings(saved)
    } catch (err) {
      console.error("Failed to load persisted settings:", err)
    }
    await nextTick()
    hydrated.value = true
  }

  function schedulePersist() {
    if (!hydrated.value) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      const pending = window.api?.saveSettings?.(snapshotForPersist())
      if (pending) {
        void pending.catch((err: unknown) => {
          console.error("Failed to persist settings:", err)
        })
      }
    }, 400)
  }

  watch(
    [preset, outputDir, outputBesideSource, savedCustomOutputDir, outputMode, prefix, suffix, tune, adv],
    schedulePersist,
    { deep: true }
  )

  return {
    hydrated,
    hydrate,
    snapshotForPersist,
    inputs,
    outputDir,
    outputBesideSource,
    savedCustomOutputDir,
    setOutputBesideSource,
    setCustomOutputDir,
    commitCustomOutputDir,
    outputMode,
    prefix,
    suffix,
    preset,
    tune,
    adv,
    isDimensionDirty,
    isQualityDirty,
    isBitrateDirty,
    isFpsDirty,
    isSpeedDirty,
    isAudioCodecDirty,
    isAudioBitrateDirty,
    videoDirtyCount,
    audioDirtyCount,
    resetParam,
    resetVideoTune,
    resetAudioTune,
    isOutputDirDirty,
    isOutputModeDirty,
    isPrefixDirty,
    isSuffixDirty,
    outputDirtyCount,
    resetOutputSettings,
    addInputs,
    removeInput,
    removeInputs,
    clearInputs,
  }
})
