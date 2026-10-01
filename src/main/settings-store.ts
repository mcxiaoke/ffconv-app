import path from "node:path"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import type { AppSettings, PersistedAdv, PersistedTune } from "../shared/contracts.js"

/**
 * 用户设置持久化（`userData/settings.json`）。
 *
 * 与 FfmpegManifest 同风格：主进程注入文件路径、原子写入（tmp + rename）、
 * 出错不阻塞启动。
 *
 * **所有落盘数据都经白名单校验**：渲染层是信任度最低的一方，
 * 它传什么都不能直接写进磁盘——只接受已知字段，类型/枚举/范围一一收窄，
 * 字符串截断到上限。未知字段一律丢弃（防止 settings.json 被当作任意数据信箱）。
 */

const MAX_STRING_LEN = 4096

const HWACCELS = new Set(["auto", "cuda", "qsv", "amf", "d3d11va", "cpu"])
const DECODE_MODES = new Set(["auto", "gpu", "cpu"])
const OUTPUT_MODES = new Set(["tree", "dir", "file"])

function defaultTune(): PersistedTune {
  return {
    dimension: 0,
    quality: 0,
    bitrate: "",
    fps: 0,
    speed: 0,
    audioCodec: "",
    audioBitrate: "",
  }
}

function defaultAdv(): PersistedAdv {
  return {
    hwaccel: "auto",
    decodeMode: "auto",
    jobs: 1,
    override: false,
    anime: false,
    strict: false,
  }
}

export function defaultSettings(): AppSettings {
  return {
    preset: "hevc_2k",
    outputDir: "",
    outputBesideSource: true,
    savedCustomOutputDir: "",
    outputMode: "dir",
    prefix: "",
    suffix: "",
    tune: defaultTune(),
    adv: defaultAdv(),
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.slice(0, MAX_STRING_LEN) : fallback
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function asEnum<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === "string" && allowed.has(value) ? (value as T) : fallback
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function sanitizeTune(raw: unknown, base: PersistedTune): PersistedTune {
  const r = readRecord(raw)
  return {
    dimension: Math.round(asNumber(r.dimension, base.dimension, 0, 16384)),
    quality: Math.round(asNumber(r.quality, base.quality, 0, 51)),
    bitrate: asString(r.bitrate, base.bitrate),
    fps: asNumber(r.fps, base.fps, 0, 240),
    speed: asNumber(r.speed, base.speed, 0, 4),
    audioCodec: asString(r.audioCodec, base.audioCodec),
    audioBitrate: asString(r.audioBitrate, base.audioBitrate),
  }
}

function sanitizeAdv(raw: unknown, base: PersistedAdv): PersistedAdv {
  const r = readRecord(raw)
  return {
    hwaccel: asEnum(r.hwaccel, HWACCELS, base.hwaccel),
    decodeMode: asEnum(r.decodeMode, DECODE_MODES, base.decodeMode),
    jobs: Math.round(asNumber(r.jobs, base.jobs, 1, 8)),
    override: asBool(r.override, base.override),
    anime: asBool(r.anime, base.anime),
    strict: asBool(r.strict, base.strict),
  }
}

/** 合并并收窄为合法 AppSettings；`base` 为缺省来源（默认值或磁盘现值） */
export function sanitizeSettings(raw: unknown, base: AppSettings = defaultSettings()): AppSettings {
  const r = readRecord(raw)
  return {
    preset: asString(r.preset, base.preset),
    outputDir: asString(r.outputDir, base.outputDir),
    outputBesideSource: asBool(r.outputBesideSource, base.outputBesideSource),
    savedCustomOutputDir: asString(r.savedCustomOutputDir, base.savedCustomOutputDir),
    outputMode: asEnum(r.outputMode, OUTPUT_MODES, base.outputMode),
    prefix: asString(r.prefix, base.prefix),
    suffix: asString(r.suffix, base.suffix),
    tune: sanitizeTune(r.tune, base.tune),
    adv: sanitizeAdv(r.adv, base.adv),
  }
}

export class SettingsStore {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /** 读取并收窄；文件缺失/损坏一律返回 null（调用方退回默认值），绝不抛错阻塞启动 */
  async load(): Promise<AppSettings | null> {
    try {
      const raw = await readFile(this.filePath, "utf8")
      return sanitizeSettings(JSON.parse(raw))
    } catch {
      return null
    }
  }

  /** 以磁盘现值为底合并入参，收窄后原子写盘，返回实际落盘值 */
  async save(payload: unknown): Promise<AppSettings> {
    const base = (await this.load()) ?? defaultSettings()
    const merged = sanitizeSettings(payload, base)
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    await writeFile(tempPath, JSON.stringify(merged, null, 2), "utf8")
    await rename(tempPath, this.filePath)
    return merged
  }
}
