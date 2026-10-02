import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import type { QueueItem, QueueItemStatus, QueueSnapshot, QueueStats } from "../shared/contracts.js"

/**
 * 持久化转码队列（`userData/queue.json`）。
 *
 * 与 SettingsStore 同纪律：主进程注入文件路径、白名单收窄、原子写入（tmp + rename）、
 * 防抖落盘、出错不阻塞启动。
 *
 * 与 SettingsStore 的三点差异：
 * 1. **按 canonical resolved path 为键**：路径是去重与执行期回写的唯一键
 *    （队列项 id 只用于 IPC 排序契约，不参与回写）；
 * 2. **写盘防抖**：执行期状态回写会高频触发，逐次落盘既浪费又放大竞态；
 * 3. **单条容错**：一条脏数据只丢它自己（并跳过），不让整份队列陪葬。
 */

const QUEUE_SCHEMA_VERSION = 1
const MAX_STRING_LEN = 4096
const PERSIST_DEBOUNCE_MS = 400

const QUEUE_STATUSES = new Set<QueueItemStatus>([
  "queued",
  "running",
  "success",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
])

type AddEntry = { path: string; name?: string; size?: number; srcMtimeMs?: number | null }
type StatusPatch = { status?: QueueItemStatus; error?: string | null; fileDst?: string | null }

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.slice(0, MAX_STRING_LEN) : fallback
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_STRING_LEN) : null
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 收窄单条队列项；路径不合法（非绝对路径）时返回 null，由调用方跳过该条 */
function sanitizeQueueItem(raw: unknown): QueueItem | null {
  const r = readRecord(raw)
  const itemPath = asString(r.path, "")
  if (!itemPath || !path.isAbsolute(itemPath)) return null
  const status = asString(r.status, "queued") as QueueItemStatus
  const srcMtimeMs = asNumber(r.srcMtimeMs, Number.NaN)
  return {
    id: asString(r.id, `q_${randomUUID()}`),
    path: itemPath,
    name: asString(r.name, path.basename(itemPath)),
    size: Math.max(0, Math.floor(asNumber(r.size, 0))),
    srcMtimeMs: Number.isFinite(srcMtimeMs) ? srcMtimeMs : null,
    status: QUEUE_STATUSES.has(status) ? status : "queued",
    error: asStringOrNull(r.error),
    fileDst: asStringOrNull(r.fileDst),
    enqueuedAt: Math.floor(asNumber(r.enqueuedAt, Date.now())),
  }
}

function computeStats(items: QueueItem[]): QueueStats {
  const stats: QueueStats = {
    total: items.length,
    queued: 0,
    running: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    interrupted: 0,
  }
  for (const item of items) stats[item.status] += 1
  return stats
}

function cloneItem(item: QueueItem): QueueItem {
  return { ...item }
}

/** canonical 键：与 ffmpeg-service 的 stagedEntries 保持同一口径（path.resolve） */
function canonicalKey(p: string): string {
  return path.resolve(p)
}

export class QueueStore {
  private readonly filePath: string
  private items: QueueItem[] = []
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /**
   * 读取并收窄整份队列。
   * 文件缺失 = 全新安装（空队列，不备份）；JSON 损坏或 schemaVersion 未知 =
   * 备份为 `.bak` 后从空队列启动——**不猜**旧版本语义，避免误跑。
   */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch {
      this.items = []
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.backup(raw)
      this.items = []
      return
    }

    const record = readRecord(parsed)
    if (record.schemaVersion !== QUEUE_SCHEMA_VERSION) {
      await this.backup(raw)
      this.items = []
      return
    }

    const rawItems = Array.isArray(record.items) ? record.items : []
    const items: QueueItem[] = []
    const seen = new Set<string>()
    for (const rawItem of rawItems) {
      const item = sanitizeQueueItem(rawItem)
      if (!item) continue
      const key = canonicalKey(item.path)
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
    this.items = items
  }

  getSnapshot(): QueueSnapshot {
    const items = this.items.map(cloneItem)
    return { schemaVersion: QUEUE_SCHEMA_VERSION, items, stats: computeStats(items) }
  }

  /** 追加条目；已存在（按 canonical 路径）的静默跳过，返回真正新增的项 */
  addItems(entries: AddEntry[]): QueueItem[] {
    if (!Array.isArray(entries) || entries.length === 0) return []
    const existing = new Set(this.items.map((item) => canonicalKey(item.path)))
    const added: QueueItem[] = []
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string" || !entry.path) continue
      const resolved = path.resolve(entry.path)
      const key = canonicalKey(resolved)
      if (existing.has(key)) continue
      existing.add(key)
      const srcMtimeMs = asNumber(entry.srcMtimeMs, Number.NaN)
      const item: QueueItem = {
        id: `q_${randomUUID()}`,
        path: resolved,
        name: asString(entry.name, path.basename(resolved)),
        size: Math.max(0, Math.floor(asNumber(entry.size, 0))),
        srcMtimeMs: Number.isFinite(srcMtimeMs) ? srcMtimeMs : null,
        status: "queued",
        error: null,
        fileDst: null,
        enqueuedAt: Date.now(),
      }
      this.items.push(item)
      added.push(item)
    }
    if (added.length > 0) this.schedulePersist()
    return added
  }

  removeByPaths(paths: unknown): number {
    if (!Array.isArray(paths) || paths.length === 0) return 0
    const targets = new Set<string>()
    for (const p of paths) {
      if (typeof p === "string" && p) targets.add(canonicalKey(p))
    }
    if (targets.size === 0) return 0
    const before = this.items.length
    this.items = this.items.filter((item) => !targets.has(canonicalKey(item.path)))
    const removed = before - this.items.length
    if (removed > 0) this.schedulePersist()
    return removed
  }

  clear(): number {
    const removed = this.items.length
    if (removed === 0) return 0
    this.items = []
    this.schedulePersist()
    return removed
  }

  /**
   * 全量重排：`ids` 必须与现有 id 集合构成同一排列。
   * 任何长度/元素不一致都拒绝（返回 false），不做部分应用——避免渲染层错发时静默错位。
   */
  reorder(ids: unknown): boolean {
    if (!Array.isArray(ids)) return false
    const current = this.items.map((item) => item.id)
    if (ids.length !== current.length) return false
    const seen = new Set<string>()
    for (const id of ids) {
      if (typeof id !== "string" || seen.has(id)) return false
      seen.add(id)
    }
    for (const id of current) {
      if (!seen.has(id)) return false
    }
    const byId = new Map(this.items.map((item) => [item.id, item]))
    this.items = (ids as string[]).map((id) => byId.get(id) as QueueItem)
    this.schedulePersist()
    return true
  }

  /** 按 canonical 路径回写执行期状态（引擎事件 → 队列的唯一写入口） */
  updateByPath(itemPath: unknown, patch: StatusPatch): boolean {
    if (typeof itemPath !== "string" || !itemPath) return false
    const key = canonicalKey(itemPath)
    const item = this.items.find((entry) => canonicalKey(entry.path) === key)
    if (!item) return false
    let changed = false
    if (patch.status && item.status !== patch.status) {
      item.status = patch.status
      changed = true
    }
    if (patch.error !== undefined && item.error !== patch.error) {
      item.error = patch.error
      changed = true
    }
    if (patch.fileDst !== undefined && item.fileDst !== patch.fileDst) {
      item.fileDst = patch.fileDst
      changed = true
    }
    if (changed) this.schedulePersist()
    return changed
  }

  /**
   * 崩溃语义：上次运行中被中断的项降级为 `interrupted`。
   * 只在启动恢复时调用一次；返回是否有改动。
   */
  markRunningInterrupted(): boolean {
    let changed = false
    for (const item of this.items) {
      if (item.status === "running") {
        item.status = "interrupted"
        changed = true
      }
    }
    if (changed) this.schedulePersist()
    return changed
  }

  /** 立即写盘并取消待执行的防抖计时器（退出前调用） */
  async flushPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    await this.persist()
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, PERSIST_DEBOUNCE_MS)
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const payload = {
        schemaVersion: QUEUE_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        items: this.items,
      }
      const tempPath = `${this.filePath}.tmp`
      await writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8")
      await rename(tempPath, this.filePath)
    } catch {
      // 落盘失败不阻塞运行：内存队列仍可用，下次变更会重试
    }
  }

  private async backup(raw: string): Promise<void> {
    try {
      await writeFile(`${this.filePath}.bak`, raw, "utf8")
    } catch {
      // 备份失败不影响降级（从空队列启动）
    }
  }
}