import path from "node:path"
import { readFile, realpath, rename, writeFile } from "node:fs/promises"

/**
 * 原生对话框已选根路径白名单（S-1 加固的一部分）。
 *
 * 纯配置/持久化辅助工具：由 main 注入存储文件路径，**不持有任何 session 状态**。
 * 复合判定 isKnownMediaPath 留在 ffmpeg-service.ts，由运行时状态（staged/currentPlan）
 * 与白名单组合，避免反向引用与职责倒挂。
 */
export class PathWhitelist {
  private readonly authorizedRoots = new Set<string>()
  private readonly storageFile: string

  constructor(storageFile: string) {
    this.storageFile = storageFile
  }

  /** 路径比对键：绝对路径 + win32 大小写不敏感 */
  normalizeForCompare(p: string) {
    const resolved = path.resolve(p)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }

  /** 登记用户通过原生对话框明确选择的路径（来源不可被渲染层伪造） */
  authorizePaths(paths: unknown) {
    if (!Array.isArray(paths)) return
    let changed = false
    for (const p of paths) {
      if (typeof p !== "string" || !p || !path.isAbsolute(p)) continue
      const key = this.normalizeForCompare(p)
      if (this.authorizedRoots.has(key)) continue
      this.authorizedRoots.add(key)
      changed = true
    }
    if (changed) {
      const tmp = `${this.storageFile}.tmp`
      writeFile(tmp, JSON.stringify([...this.authorizedRoots], null, 2), "utf8")
        .then(() => rename(tmp, this.storageFile))
        .catch(() => {
          // 授权持久化失败不阻塞主流程，本次会话内仍然有效
        })
    }
  }

  /** 启动时从本地 JSON 恢复历史授权 */
  async loadAuthorizedPaths() {
    try {
      const raw = await readFile(this.storageFile, "utf8")
      const list = JSON.parse(raw)
      if (Array.isArray(list)) this.authorizePaths(list)
    } catch {
      // 文件不存在或损坏时静默忽略，等价于无历史授权
    }
  }

  /** target 是否属于某个已授权根自身或其子路径 */
  isAuthorizedRoot(targetPath: string): boolean {
    const target = this.normalizeForCompare(targetPath)
    for (const root of this.authorizedRoots) {
      const prefix = root.endsWith(path.sep) ? root : root + path.sep
      if (target === root || target.startsWith(prefix)) return true
    }
    return false
  }

  /**
   * isAuthorizedRoot 的 realpath 加固版（防 junction/symlink 穿越绕过）。
   *
   * 词法判定（isAuthorizedRoot）只做 `path.resolve` 字符串比较：已授权根里放一个
   * junction 指向白名单外（如 D:\Media\link → E:\secret），请求
   * `D:\Media\link\file` 也能通过词法比较，随后 shell.openPath 跟随链接打开真实目标。
   * 这里在词法通过后，把「匹配的授权根」与「target 的最长已存在前缀」都解析到
   * 真实路径再比一次——真实路径落在所有授权根之外即拒绝。
   *
   * 解析失败时（根已被删除/移动、target 在校验瞬间被删等）退回词法判定，
   * 即保持旧行为：此时 open/show 本身也会因路径不存在而失败，不构成放行面。
   */
  async isAuthorizedRootResolved(targetPath: string): Promise<boolean> {
    if (!this.isAuthorizedRoot(targetPath)) return false

    const target = this.normalizeForCompare(targetPath)
    let matchedRoot: string | null = null
    for (const root of this.authorizedRoots) {
      const prefix = root.endsWith(path.sep) ? root : root + path.sep
      if (target === root || target.startsWith(prefix)) {
        matchedRoot = root
        break
      }
    }
    if (!matchedRoot) return false

    let realRoot: string
    try {
      realRoot = this.normalizeForCompare(await realpath(matchedRoot))
    } catch {
      return true // 授权根不可解析（已删除等）：退回词法判定
    }

    const realTarget = await realpathLongestExisting(targetPath)
    if (!realTarget) return true // target 无法解析：退回词法判定
    const realTargetKey = this.normalizeForCompare(realTarget)
    const realPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
    return realTargetKey === realRoot || realTargetKey.startsWith(realPrefix)
  }
}

/**
 * 解析 p 的真实路径；若 p（或其中间组件）不存在，则对最长已存在前缀做 realpath，
 * 剩余后缀按词法拼回。全链路（直到盘根）都不可解析时返回 null。
 * 中间组件里的 junction/symlink 仍会被 realpath 展开——这正是本函数的目的。
 */
async function realpathLongestExisting(p: string): Promise<string | null> {
  let current = path.resolve(p)
  let suffix = ""
  for (;;) {
    try {
      const real = await realpath(current)
      return suffix ? path.join(real, suffix) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return null
      suffix = suffix ? path.join(path.basename(current), suffix) : path.basename(current)
      current = parent
    }
  }
}
