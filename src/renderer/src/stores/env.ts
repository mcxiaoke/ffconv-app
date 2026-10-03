import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { EnvironmentSummary, PresetCatalog } from "../../../shared/contracts"
import { useLogStore } from "./log"

/** 把启动期环境加载失败写进日志面板（只 console.error 等于用户无感知） */
function logEnvFailure(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  useLogStore().append({
    level: "ERROR",
    message: `${message}: ${detail}`,
    timestamp: new Date().toLocaleTimeString(),
  })
}

export const useEnvStore = defineStore("env", () => {
  const version = ref("0.1.0")
  const summary = ref<EnvironmentSummary | null>(null)
  /**
   * 轻量预设目录（二进制定位 + 分层预设，无硬件探测）。
   * 启动时最先返回，让左侧面板立刻可用；硬件信息随后由 summary 补齐。
   */
  const catalog = ref<PresetCatalog | null>(null)
  const loading = ref(false)

  /** 统一的预设来源：轻量目录优先，summary 到达后两者内容一致 */
  const presets = computed(() => catalog.value?.presets ?? summary.value?.presets ?? [])
  const ffmpegPath = computed(() => catalog.value?.ffmpegPath ?? summary.value?.ffmpegPath ?? null)
  const ffprobePath = computed(() => catalog.value?.ffprobePath ?? summary.value?.ffprobePath ?? null)
  /** 硬件信息是否已到达（未到达时状态栏显示「探测中」而非误报「未找到」） */
  const hardwareReady = computed(() => summary.value !== null)

  /**
   * 只取预设与二进制定位——**不含**硬件探测。
   *
   * 硬件探测要先跑 `ffmpeg -version`、枚举数百个编码器，再按 GPU 矩阵逐项探测
   * （可达 30+ 次 ffmpeg 调用，实测 1~2s）。预设下拉只依赖磁盘上的 YAML，
   * 没理由为它等待。
   */
  async function fetchPresets() {
    try {
      version.value = await window.api.getAppVersion()
      catalog.value = await window.api.getPresetCatalog()
    } catch (err) {
      console.error("Failed to load preset catalog:", err)
      logEnvFailure("预设目录加载失败（预设下拉将为空）", err)
    }
  }

  /** 完整摘要（含硬件/系统）；启动时后台刷新，设置变更与「关于」重检也会调用 */
  async function fetchEnv() {
    try {
      loading.value = true
      const next = await window.api.getEnvironment()
      summary.value = next
      // summary 里同样带预设与路径，回填 catalog，避免两个来源各自漂移
      catalog.value = {
        ffmpegPath: next.ffmpegPath,
        ffprobePath: next.ffprobePath,
        presets: next.presets,
      }
    } catch (err) {
      console.error("Failed to load environment:", err)
      logEnvFailure("环境探测失败（硬件信息不可用）", err)
    } finally {
      loading.value = false
    }
  }

  return {
    version,
    summary,
    catalog,
    presets,
    ffmpegPath,
    ffprobePath,
    hardwareReady,
    loading,
    fetchPresets,
    fetchEnv,
  }
})
