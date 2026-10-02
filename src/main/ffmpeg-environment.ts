import os from "node:os"
import { existsSync } from "node:fs"
import path from "node:path"
import { execa } from "execa"
import {
  detectHardwareCapabilities,
  presets,
  resolveFFmpegBinary,
  resolveFFprobeBinary,
  resolvePreviewHwPlan,
  setFFmpegPath,
} from "../../core/transcode/index.js"
import type { EnvironmentSummary, PresetCatalog } from "../shared/contracts.js"

export interface FfmpegEnvironmentDeps {
  /** 注入 Electron app 的应用路径（打包/开发两种布局的候选回退需要） */
  getAppPath: () => string
}

/** 环境层降级/异常的统一出口（与 main/index.ts 的 startupLog 同风格，避免在此 import electron） */
function logStartup(message: string): void {
  try {
    console.warn(`[ffmpeg-env] ${message}`)
  } catch {
    // 日志失败不得掩盖原始问题
  }
}

/**
 * detectHardwareCapabilities 的返回形状。
 * JS 侧没有导出的类型，这里只声明桌面端**实际消费**的字段（其余走索引签名）。
 */
type HardwareCapabilities = {
  version?: string
  vendor?: string
  encoders?: Set<string> | string[]
  hwaccels?: string[]
  gpus?: Array<{ vendor?: string; model?: string; name?: string; generation?: number }>
  [key: string]: unknown
}

/**
 * ffmpeg/ffprobe 定位与缓存、bundled/preset 资源候选、硬件能力探测与
 * EnvironmentSummary 构造。依赖经 constructor 注入，不直接 import electron。
 */
export class FfmpegEnvironment {
  private ffmpegPath: string | null = null
  private ffprobePath: string | null = null
  private customFfmpegPath: string | null = null
  private customFfprobePath: string | null = null
  /** 用户显式指定的 mediainfo（ffprobe 失败时的兜底探测工具）；null = 用 PATH 中的 mediainfo */
  private customMediainfoPath: string | null = null
  /** ffprobe 版本标识（首行 `ffprobe version <x>`），只探测一次 */
  private ffprobeVersion: string | null = null
  private hardware: HardwareCapabilities | null = null
  /** 分层预设是否已加载（只与磁盘 YAML 有关，进程内一次即可） */
  private presetsLoaded = false
  private readonly getAppPath: () => string

  constructor(deps: FfmpegEnvironmentDeps) {
    this.getAppPath = deps.getAppPath
  }

  /** 已解析到的 ffprobe 路径（未解析时为 null），供 staging/plan 探针使用 */
  get resolvedFfprobePath(): string | null {
    return this.ffprobePath
  }

  /**
   * 用户显式指定的 mediainfo 路径（未指定时为 null）。
   * 供媒体探测作为 ffprobe 失败后的兜底工具使用 —— 此前该设置只被渲染层收集和持久化，
   * 主进程完全不消费，是纯粹的「死控件」。
   */
  get resolvedMediainfoPath(): string | null {
    return this.customMediainfoPath
  }

  /** 已解析到的 ffmpeg 路径（未解析时为 null），供「关于」等只读展示使用 */
  getFfmpegPath(): string | null {
    return this.ffmpegPath
  }

  /**
   * 硬件能力探测结果（进程内缓存；未探测时为 null）。
   *
   * 宿主「实测本机命令」需要把同一份 caps 交给引擎的 selectTier，
   * 避免重复探测、也保证与执行期结论同源。调用方须先 await getSummary()。
   */
  getHardwareCapabilities(): HardwareCapabilities | null {
    return this.hardware
  }

  async setCustomToolPaths(paths: {
    ffmpeg?: string
    ffprobe?: string
    mediainfo?: string
  }): Promise<EnvironmentSummary> {
    const rawFfmpeg = typeof paths?.ffmpeg === "string" ? paths.ffmpeg.trim() : ""
    const rawFfprobe = typeof paths?.ffprobe === "string" ? paths.ffprobe.trim() : ""
    const rawMediainfo = typeof paths?.mediainfo === "string" ? paths.mediainfo.trim() : ""

    let changed = false

    // ⚠️ 路径不存在时必须**报错**，不能静默忽略。
    // 旧实现只 existsSync 通过才赋值，不通过就什么都不做：promise 正常 resolve，
    // 设置面板刷新后仍显示旧路径，用户以为已生效，直到转码时才报莫名其妙的错。
    if (rawFfmpeg) {
      if (!existsSync(rawFfmpeg)) {
        throw new Error(`ffmpeg 路径不存在: ${rawFfmpeg}`)
      }
      this.customFfmpegPath = rawFfmpeg
      this.ffmpegPath = rawFfmpeg
      setFFmpegPath(rawFfmpeg)
      this.hardware = null
      changed = true
    } else if (this.customFfmpegPath) {
      this.customFfmpegPath = null
      this.ffmpegPath = null
      this.hardware = null
      changed = true
    }

    if (rawFfprobe) {
      if (!existsSync(rawFfprobe)) {
        throw new Error(`ffprobe 路径不存在: ${rawFfprobe}`)
      }
      this.customFfprobePath = rawFfprobe
      this.ffprobePath = rawFfprobe
      // 换了二进制就要重新读版本，否则面板会显示旧版本
      this.ffprobeVersion = null
      changed = true
    } else if (this.customFfprobePath) {
      this.customFfprobePath = null
      this.ffprobePath = null
      this.ffprobeVersion = null
      changed = true
    }

    // mediainfo 只作 ffprobe 失败后的兜底探测，不参与能力探测，故不置 changed
    if (rawMediainfo) {
      if (!existsSync(rawMediainfo)) {
        throw new Error(`mediainfo 路径不存在: ${rawMediainfo}`)
      }
      this.customMediainfoPath = rawMediainfo
    } else if (this.customMediainfoPath) {
      this.customMediainfoPath = null
    }

    if (changed || !this.ffmpegPath) {
      await this.ensureFfmpegPath()
    }
    return this.getSummary()
  }

  private resolvePresetPath() {
    const candidates = [
      path.join(process.resourcesPath, "presets", "default.yaml"),
      path.join(this.getAppPath(), "out", "presets", "default.yaml"),
      path.join(this.getAppPath(), "presets", "default.yaml"),
      path.join(this.getAppPath(), "..", "presets", "default.yaml"),
      path.join(this.getAppPath(), "..", "..", "presets", "default.yaml"),
      path.join(this.getAppPath(), "..", "..", "..", "..", "presets", "default.yaml"),
      path.resolve(process.cwd(), "out", "presets", "default.yaml"),
      path.resolve(process.cwd(), "presets", "default.yaml"),
      path.resolve(process.cwd(), "..", "..", "presets", "default.yaml"),
    ]
    return candidates.find((candidate) => existsSync(candidate)) || null
  }

  /**
   * 打包后的 ffmpeg 候选位置（electron-builder extraResources / resources）。
   * 与预设文件的 resourcesPath 回退对称，避免「预设能找到、ffmpeg 找不到」。
   */
  private bundledFfmpegCandidates(): string[] {
    const binary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
    const roots = [process.resourcesPath, path.join(this.getAppPath(), "resources")].filter(
      (root): root is string => typeof root === "string" && root.length > 0,
    )
    return roots.flatMap((root) => [
      path.join(root, "ffmpeg", "bin", binary),
      path.join(root, "ffmpeg", binary),
      path.join(root, "bin", binary),
    ])
  }

  /**
   * 计划阶段的**预计**硬件分层（不做逐文件 ffmpeg 干跑）。
   *
   * 任务真正的 hwPlan 要到执行期才由 runFFmpegCmd 逐文件探测后注入，计划期传 null 会让
   * createFFmpegArgs 直接返回空参数（无 -c:v、无缩放）。这里走引擎的能力级决策
   * （resolvePreviewHwPlan：候选链 + GPU 矩阵预筛，复用执行期同一套规则），
   * 使预览反映「本机大概率会用哪一层」，而不是恒为软件编码。
   */
  buildPreviewHwPlan(options: {
    decodeMode?: string
    hwaccel?: string
    path?: string
    presetType?: string
    codec?: string
    pixFmt?: string
    bitDepth?: number | string
    codecFamily?: string
  } = {}) {
    return resolvePreviewHwPlan({ caps: this.hardware, ...options })
  }

  /**
   * 确保分层预设已加载。
   *
   * ⚠️ 失败判定必须在 `initPresetsAsync()` **之后**。
   * 旧实现在加载前就看 `presets.getAllNames().length`，那个值在首次加载前恒为 0，
   * 于是无条件进入分支、无条件打一行 `presets: bundled default not found at <找到的路径>`——
   * 日志与事实相反（它打印的就是解析成功的路径），把人往「预设没找到」上带。
   */
  private async ensurePresetsLoaded(): Promise<void> {
    if (this.presetsLoaded) return
    // 不能把内置 default.yaml 当 customPath 传：loadPresetLayers(customPath) 的语义是
    // 「**只**加载这一个文件」，那样 USER_SEARCH_PATHS（~/.mediac/presets.yaml、
    // cwd/presets.yaml）永远用不上——GUI 用户在用户层加的预设/覆盖会被静默忽略。
    // 不传 customPath 才会走完整分层。
    await presets.initPresetsAsync()
    this.presetsLoaded = true
    if (!presets.getAllNames().length) {
      const presetPath = this.resolvePresetPath()
      throw new Error(
        presetPath
          ? `FFmpeg 预设解析失败：已找到 ${presetPath}，但未解析出任何预设`
          : "FFmpeg 内置预设文件 default.yaml 未找到",
      )
    }
  }

  /** 公开预设列表（供 getSummary 与轻量通道共用） */
  private presetList(): EnvironmentSummary["presets"] {
    return presets.getAllNames().map((name: string) => {
      const preset = presets.getPreset(name)
      return {
        name,
        type: preset?.type || "video",
        format: preset?.format || ".mp4",
        videoCodecFamily: preset?.videoCodecFamily || "",
        audioCodec: preset?.audioCodec || "",
        videoQuality: preset?.videoQuality || 0,
        videoBitrate: preset?.videoBitrate || 0,
        audioBitrate: preset?.audioBitrate || 0,
        dimension: preset?.dimension || 0,
      }
    })
  }

  /**
   * 轻量目录：二进制定位 + 分层预设，**不做**硬件能力探测。
   *
   * 启动时先走这条：硬件探测（ffmpeg -version、枚举 244 个编码器、按 GPU 矩阵逐项探测）
   * 耗时 1~2s，而左侧面板的预设下拉只依赖磁盘上的 YAML。
   */
  async getPresetCatalog(): Promise<PresetCatalog> {
    await this.ensureFfmpegPath()
    if (this.customFfprobePath && existsSync(this.customFfprobePath)) {
      this.ffprobePath = this.customFfprobePath
    } else if (!this.ffprobePath) {
      this.ffprobePath = await resolveFFprobeBinary(this.ffmpegPath || undefined)
    } else if (!existsSync(this.ffprobePath)) {
      this.ffprobePath = await resolveFFprobeBinary(this.ffmpegPath || undefined)
    }
    await this.ensurePresetsLoaded()
    return {
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath,
      presets: this.presetList(),
    }
  }

  /**
   * 读取 ffprobe 版本标识（首行 `ffprobe version <x> Copyright ...`）。
   * 只探测一次并缓存；失败返回 null —— 版本仅用于「关于」面板展示，不应影响任何能力。
   */
  private async resolveFfprobeVersion(): Promise<string | null> {
    if (this.ffprobeVersion) return this.ffprobeVersion
    if (!this.ffprobePath) return null
    try {
      const res = await execa(this.ffprobePath, ["-hide_banner", "-version"], {
        reject: false,
        timeout: 5000,
      })
      const matched = String(res.stdout || "").match(/^ffprobe version\s+(\S[^\r\n]*?)\s+Copyright/i)
      this.ffprobeVersion = matched ? matched[1].trim() : null
    } catch {
      this.ffprobeVersion = null
    }
    return this.ffprobeVersion
  }

  /** 兜底解析 ffmpeg（执行前置），未找到返回 null */
  async ensureFfmpegPath(): Promise<string | null> {
    if (this.customFfmpegPath && existsSync(this.customFfmpegPath)) {
      this.ffmpegPath = this.customFfmpegPath
      setFFmpegPath(this.ffmpegPath)
      return this.ffmpegPath
    }
    if (!this.ffmpegPath) {
      this.ffmpegPath = await resolveFFmpegBinary({ extraCandidates: this.bundledFfmpegCandidates() })
      if (this.ffmpegPath) setFFmpegPath(this.ffmpegPath)
    } else if (!existsSync(this.ffmpegPath)) {
      // ⚠️ 非自定义路径此前**从不校验存在性**（只在为 null 时解析一次）：
      // 用户卸载 ffmpeg、拔掉移动盘、或被杀软隔离后，this.ffmpegPath 仍是死路径，
      // 于是「未找到 ffmpeg」的友好提示不会触发，直接拿 ENOENT 去跑。
      // 自定义路径每次都 existsSync，这里对非自定义路径做同样的校验。
      logStartup(`cached ffmpeg path no longer exists, re-resolving: ${this.ffmpegPath}`)
      this.ffmpegPath = null
      this.hardware = null
      this.ffmpegPath = await resolveFFmpegBinary({ extraCandidates: this.bundledFfmpegCandidates() })
      if (this.ffmpegPath) setFFmpegPath(this.ffmpegPath)
    }
    return this.ffmpegPath
  }

  /** 确保 ffmpeg/ffprobe 已定位并完成能力探测与预设加载，返回 EnvironmentSummary */
  async getSummary(): Promise<EnvironmentSummary> {
    await this.ensureFfmpegPath()
    if (this.customFfprobePath && existsSync(this.customFfprobePath)) {
      this.ffprobePath = this.customFfprobePath
    } else if (!this.ffprobePath) {
      this.ffprobePath = await resolveFFprobeBinary(this.ffmpegPath || undefined)
    } else if (!existsSync(this.ffprobePath)) {
      // 同 ensureFfmpegPath：缓存的 ffprobe 失效后必须重新解析
      logStartup(`cached ffprobe path no longer exists, re-resolving: ${this.ffprobePath}`)
      this.ffprobePath = await resolveFFprobeBinary(this.ffmpegPath || undefined)
    }
    await this.ensurePresetsLoaded()
    if (this.ffmpegPath && !this.hardware) {
      // detectHardwareCapabilities 的 JSDoc 只声明 `Promise<object>`，按其文档形状断言
      this.hardware = (await detectHardwareCapabilities({
        ffmpegPath: this.ffmpegPath,
      })) as HardwareCapabilities
    }
    const ffprobeVersion = await this.resolveFfprobeVersion()

    const vendor = (this.hardware?.vendor || "").toLowerCase()
    const encoders = Array.from(this.hardware?.encoders || []) as string[]
    let tier: "nvidia" | "intel" | "amd" | "cpu" = "cpu"
    if (vendor.includes("nvidia") || encoders.some((e: string) => e.includes("nvenc"))) {
      tier = "nvidia"
    } else if (vendor.includes("intel") || encoders.some((e: string) => e.includes("qsv"))) {
      tier = "intel"
    } else if (vendor.includes("amd") || encoders.some((e: string) => e.includes("amf"))) {
      tier = "amd"
    }

    return {
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath,
      // ffmpeg 版本来自能力探测（同一进程内缓存），ffprobe 版本单独探测一次
      ffmpegVersion: this.hardware?.version || null,
      ffprobeVersion,
      mediainfoPath: this.customMediainfoPath,
      presets: this.presetList(),
      hardware: {
        gpus: (this.hardware?.gpus || []).map((g) => ({
          vendor: g.vendor || "Unknown",
          model: g.model || g.name || "Unknown GPU",
          // 契约里 generation 是字符串；gpu.js 侧是数字代次（如 40），此处归一化
          generation: g.generation === undefined ? undefined : String(g.generation),
        })),
        encoders,
        hwaccels: Array.from(this.hardware?.hwaccels || []),
        tier,
      },
      system: {
        cpuModel: os.cpus()[0]?.model?.trim() || "CPU",
        cpuCores: os.cpus().length,
        totalMemGb: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
        freeMemGb: Math.round(os.freemem() / (1024 * 1024 * 1024)),
      },
    }
  }
}
