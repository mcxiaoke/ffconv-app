export type RunnerState =
  | "IDLE"
  | "PLANNING"
  | "READY"
  | "RUNNING"
  | "STOPPING"
  | "STOPPED"
  | "COMPLETED"
  | "FAILED"
  | "STALE"

export type TaskStatus =
  | "staged"
  | "pending"
  | "preparing"
  | "running"
  | "retrying"
  | "success"
  | "failed"
  | "skipped"
  | "cancelled"

export interface SelectFileOptions {
  mode: "file" | "directory"
  multiple?: boolean
}

export interface EnvironmentSummary {
  ffmpegPath: string | null
  ffprobePath: string | null
  /** ffmpeg 版本标识（`ffmpeg -version` 首行的 version 段），未探测到时为 null */
  ffmpegVersion?: string | null
  /** ffprobe 版本标识（`ffprobe -version` 首行的 version 段），未探测到时为 null */
  ffprobeVersion?: string | null
  /** 用户显式指定的 mediainfo（ffprobe 失败时的兜底探测工具）；null = 使用 PATH 中的 mediainfo */
  mediainfoPath?: string | null
  presets: Array<{
    name: string
    type: string
    format: string
    videoCodecFamily: string
    audioCodec: string
    videoQuality: number
    videoBitrate: number
    audioBitrate: number
    dimension: number
  }>
  hardware: {
    gpus: Array<{ vendor: string; model: string; generation?: string }>
    encoders: string[]
    hwaccels: string[]
    tier: "nvidia" | "intel" | "amd" | "cpu"
  }
  system?: {
    cpuModel: string
    cpuCores: number
    totalMemGb: number
    freeMemGb: number
  }
}

/**
 * 轻量预设目录：只含二进制定位与分层预设，**不含**硬件能力探测。
 *
 * 用于启动时先让左侧面板可用：硬件探测要跑 `ffmpeg -version`、枚举数百个编码器、
 * 再按 GPU 矩阵逐项探测（可达 30+ 次 ffmpeg 调用，1~2s），而预设下拉只依赖 YAML。
 */
export interface PresetCatalog {
  ffmpegPath: string | null
  ffprobePath: string | null
  presets: EnvironmentSummary["presets"]
}

export interface MediaInfoPayload {
  provider?: string
  format?: string
  size?: number
  duration?: number
  bitrate?: number
  createdAt?: string
  video?: {
    type?: string
    format?: string
    codec?: string
    profile?: string
    level?: number | string
    width?: number
    height?: number
    aspectRatio?: string
    framerate?: number
    pixelFormat?: string
    bitDepth?: number
    bitrate?: number
    size?: number
    duration?: number
    tags?: Record<string, string>
    [key: string]: unknown
  }
  audio?: {
    type?: string
    format?: string
    codec?: string
    profile?: string
    bitrate?: number
    sampleRate?: number
    channels?: number
    language?: string
    tags?: Record<string, string>
    [key: string]: unknown
  }
  subtitles?: Array<Record<string, unknown>>
  raw?: unknown
  [key: string]: unknown
}

/**
 * 引擎事件（createFFmpegEngine 的 emit payload），经 IPC `execution:event` 送到渲染层。
 *
 * 用 type 别名而非 interface：别名带隐式索引签名，可直接赋给 `Record<string, unknown>`
 * （主进程的 eventSink 参数类型），interface 则不行。
 */
export type EngineEvent = {
  type?: string
  taskId?: string
  taskIndex?: number
  level?: string
  message?: string
  timestamp?: string
  percent?: number
  speed?: number | string
  reason?: string
  failed?: boolean
  result?: { status?: string; error?: string | null; outputPath?: string | null }
  summary?: {
    total?: number
    success?: number
    failed?: number
    skipped?: number
    cancelled?: number
    retryCount?: number
    isCancelled?: boolean
    elapsedMs?: number
  }
}

export interface MediaTargetSummary {
  container?: string
  videoEncoder?: string
  width?: number
  height?: number
  fps?: number
  quality?: number
  bitrate?: number
  audioCodec?: string
  audioBitrate?: number
}

export interface PlanTask {
  id: string
  index: number
  name: string
  path: string
  size: number
  duration: number
  fileDst: string
  status: TaskStatus
  error: string | null
  skipReason: string | null
  progress?: number
  speed?: number
  mediaInfo?: MediaInfoPayload
  videoCodec?: string
  audioCodec?: string
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  srcSize?: number
  srcDuration?: number
  containerFormat?: string
  cmdPreview?: string
  bitDepth?: number
  pixelFormat?: string
  profile?: string
  level?: string
  aspectRatio?: string
  audioChannels?: number
  audioSampleRate?: number
  audioBitrate?: number
  rawMetadata?: string
  targetSummary?: MediaTargetSummary
  /**
   * 手动「实测本机命令」的结果（仅内存，不持久化）。
   * 与 cmdPreview（扫描期按能力级推断的**预计**命令）不同，它来自逐文件真跑
   * ffmpeg 干跑探测选出的**实际**层，标注为「实测」。
   */
  probeCmd?: string
  probeTier?: string
  probeTried?: string[]
  probeDegraded?: boolean
  probeReason?: string
  probeAt?: number
}

/** 「实测本机命令」IPC 返回：命中层 + 与真实执行同构的命令 */
export interface TaskProbeResult {
  taskId: string
  /** 音频任务不做视频分层，UI 置灰不再探测 */
  audio: boolean
  tier: string
  degraded: boolean
  tried: string[]
  reason: string
  /** 完整命令串（已按当前任务的输出路径渲染）；audio 时为空 */
  cmd: string
  probedAt: number
}

export interface StageInputsResult {
  added: PlanTask[]
  skippedDuplicates: number
  totalCount: number
}

export interface PublicPlanSnapshot {
  schemaVersion: number
  id: string | null
  presetName: string
  mode: string
  totalTasks: number
  totalDuration: number
  totalSize: number
  previewCmd: string
  tasks: Array<PlanTask>
}

export interface SelectFileResult {
  paths: string[]
}

export interface CustomToolPaths {
  ffmpeg?: string
  ffprobe?: string
  mediainfo?: string
}

/** 转码调参的持久化形状（与 renderer 的 TuneConfig 字段一一对应） */
export interface PersistedTune {
  dimension: number
  quality: number
  bitrate: string
  fps: number
  speed: number
  audioCodec: string
  audioBitrate: string
}

/**
 * 高级选项的持久化形状。
 *
 * 刻意**不含 deleteSource**：「转码后删除源文件」是高危开关，
 * 绝不能跨会话自动继承——每次启动都必须是显式关闭状态。
 */
export interface PersistedAdv {
  hwaccel: string
  decodeMode: string
  jobs: number
  override: boolean
  anime: boolean
  strict: boolean
}

/** 引擎日志级别（设置面板可调；默认 info） */
export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "silent"

/** 可在重启后恢复的用户设置（存 userData/settings.json） */
export interface AppSettings {
  preset: string
  outputDir: string
  outputBesideSource: boolean
  savedCustomOutputDir: string
  outputMode: "tree" | "dir" | "file"
  prefix: string
  suffix: string
  tune: PersistedTune
  adv: PersistedAdv
  /** 引擎/界面日志级别：默认 info（引擎侧两条日志路径统一按此过滤） */
  logLevel: LogLevelName
}

export interface ExecutionOptions {
  dryRun?: boolean
}

/**
 * 持久化队列项状态。
 *
 * 与 `TaskStatus` 刻意分开：队列是**跨会话**的事实源，只记录稳定结论
 * （不落 running 之外的中间态；`interrupted` 表示上次运行中被中断）。
 */
export type QueueItemStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  | "cancelled"
  | "interrupted"

/**
 * 持久化队列条目（`userData/queue.json` 的单条）。
 *
 * 只存「意图与结论」：源路径/名称/大小/源 mtime/状态/产物路径/入队时间。
 * **不存** argv / hwPlan / mediaInfo —— 它们依赖硬件探测结果与文件当前状态，
 * 跨会话复原会与阶段一的硬件能力判定冲突（详见 PHASE2 方案 D1）。
 */
export interface QueueItem {
  id: string
  path: string
  name: string
  size: number
  srcMtimeMs: number | null
  status: QueueItemStatus
  error: string | null
  fileDst: string | null
  enqueuedAt: number
}

export interface QueueStats {
  total: number
  queued: number
  running: number
  success: number
  failed: number
  skipped: number
  cancelled: number
  interrupted: number
}

/** `queue:get` / `queue:reorder` 的返回形状，也是 `queue:changed` 的载荷 */
export interface QueueSnapshot {
  schemaVersion: number
  items: QueueItem[]
  stats: QueueStats
}

export interface ExecutionSnapshot {
  status: RunnerState
  planId: string | null
  plan: PublicPlanSnapshot | null
  isExecuting: boolean
  summary: Record<string, unknown> | null
}

export interface DesktopApi {
  getPathForFile(file: File): string
  selectFiles(options: SelectFileOptions): Promise<SelectFileResult>
  stageInputs(paths: string[]): Promise<StageInputsResult>
  clearStagedInputs(): Promise<{ ok: boolean }>
  removeStagedInputs(paths: string[]): Promise<{ removed: number; totalCount: number }>
  getAppVersion(): Promise<string>
  getEnvironment(): Promise<EnvironmentSummary>
  /** 轻量预设目录（不含硬件探测），启动时优先调用 */
  getPresetCatalog(): Promise<PresetCatalog>
  setCustomToolPaths(paths: CustomToolPaths): Promise<EnvironmentSummary>
  getSettings(): Promise<AppSettings | null>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  createPlan(body: Record<string, unknown>): Promise<PublicPlanSnapshot>
  /** 手动实测本机命令：对指定任务真跑一次分层探测并返回实际命令（不自动调用） */
  probeTask(taskId: string): Promise<TaskProbeResult>
  startExecution(taskIds?: string[], options?: ExecutionOptions): Promise<{ runId: string }>
  stopExecution(): Promise<{ ok: boolean; message?: string }>
  getExecutionStatus(): Promise<ExecutionSnapshot>
  onEngineEvent(callback: (event: EngineEvent) => void): () => void
  /** 读取持久化队列快照（启动水合 / 手动刷新） */
  getQueue(): Promise<QueueSnapshot>
  /** 以全量 id 顺序重排队列；ids 必须与当前集合完全一致，否则主进程拒绝 */
  reorderQueue(ids: string[]): Promise<QueueSnapshot>
  /** 订阅主进程队列变更广播（执行期状态回写等），返回退订函数 */
  onQueueChanged(callback: (snapshot: QueueSnapshot) => void): () => void
  showInFolder(fullPath: string): Promise<void>
  openPath(fullPath: string): Promise<string>
  copyText(text: string): Promise<boolean>
  /** 把面板日志内容保存成文件；返回落盘路径，失败返回 null */
  saveLog(text: string): Promise<{ path: string } | null>
  notify(title: string, body: string): Promise<void>
  onMenuAction(callback: (action: string) => void): () => void
}
