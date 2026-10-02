/*
 * File: debug.js
 * Created: 2021-07-20 16:59:09 +0800
 * Modified: 2024-04-09 22:13:40 +0800
 * Author: mcxiaoke (github@mcxiaoke.com)
 * License: Apache License 2.0
 */

import chalk from "chalk"
import dayjs from "dayjs"
import fs from "fs-extra"
import log from "loglevel"
import prefix from "loglevel-plugin-prefix"
import os from "os"
import path from "path"
import util from "util"

// ---------------------------------------------------------------------------
// 日志汇聚点（Host Log Sink）
// ---------------------------------------------------------------------------
// 引擎日志此前只写进程 console 与系统临时文件，宿主（Electron 主进程）无从得知，
// 于是环境探测、参数编排警告等日志进不了应用内的「运行日志」面板。
// 这里提供只读汇聚回调：宿主注册后，每条日志在原有输出之外再回调一次。
//
// ⚠️ 引擎存在两条并行的日志路径，二者都必须汇聚（否则会漏掉一半日志）：
//   1) `log.info/warn/error/debug`（loglevel，见 applyCustomPlugin）
//   2) `logWithTag` 家族（logInfo/logWarn/logError/logSuccess/logTask/…）
//      —— 它们直接 console.log，不经过 loglevel，因此 setLevel 对它们无效。
const logSinks = new Set()

/**
 * 注册日志汇聚回调（宿主用，如 Electron 主进程转发到界面日志面板）
 * @param {(record: {level: string, tag: string, message: string, timestamp: number}) => void} sink
 * @returns {() => void} 取消注册
 */
export function addLogSink(sink) {
    if (typeof sink !== "function") return () => {}
    logSinks.add(sink)
    return () => logSinks.delete(sink)
}

/** 汇聚文本化：字符串原样，其余用 util.inspect（避免 [object Object]） */
function formatSinkArgs(args) {
    return args
        .map((arg) =>
            typeof arg === "string" ? arg : util.inspect(arg, { depth: 3, colors: false }),
        )
        .join(" ")
}

/** 分发到所有汇聚回调；单个回调异常不得影响日志主流程 */
function emitLogSink(level, tag, message) {
    if (logSinks.size === 0) return
    const record = { level, tag, message, timestamp: Date.now() }
    for (const sink of logSinks) {
        try {
            sink(record)
        } catch {
            // 汇聚点失败不得影响日志本身
        }
    }
}

/** LogCategory/字符串类别 → 汇聚级别（面板按 INFO/WARN/ERROR/DEBUG 过滤） */
const CATEGORY_LEVEL = {
    START: "INFO",
    END: "INFO",
    DONE: "INFO",
    OK: "INFO",
    SUCCESS: "INFO",
    SKIP: "WARN",
    WARN: "WARN",
    ERROR: "ERROR",
    FAIL: "ERROR",
    INFO: "INFO",
    DEBUG: "DEBUG",
    PROGRESS: "INFO",
    TASK: "INFO",
}

// ---------------------------------------------------------------------------
// 全局日志级别（两条路径共用）
// ---------------------------------------------------------------------------
// 此前两套机制各管各的：loglevel 受 setLevel 控制（默认 WARN，导致引擎里所有
// `log.info/debug` 诊断被静默丢弃），而 logWithTag 家族完全不受控（永远输出）。
// 现在统一到 activeLevel：默认 INFO，宿主可通过 setLogLevel 更改（设置面板可调）。
//
// ⚠️ 数值与文件后部的 `LogLevel` 常量一致（loglevel 的 TRACE..SILENT），
//    此处提前声明是为了赶在 `setupLogger()` 之前可用。
const LEVEL_BY_NAME = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, SILENT: 5 }
let activeLevel = LEVEL_BY_NAME.INFO

/**
 * 日志根目录。
 *
 * 默认落在系统临时目录（引擎独立运行时的合理默认），但**宿主可覆盖**：
 * Electron 主进程应改为应用日志目录，否则界面上「打开日志目录」看不到引擎日志。
 * ⚠️ 必须在 `setupLogger()` 之前声明：该方法会调用 getLogRootDir() 并 mkdirs。
 */
let logRootDir = path.join(os.tmpdir(), "mediac")

/** 规范化级别入参（名称或数值）；非法返回 null */
function normalizeLevel(level) {
    if (typeof level === "number" && Number.isFinite(level)) {
        return Math.min(LEVEL_BY_NAME.SILENT, Math.max(0, Math.round(level)))
    }
    const key = String(level ?? "").trim().toUpperCase()
    return key in LEVEL_BY_NAME ? LEVEL_BY_NAME[key] : null
}

/** 该级别在当前设置下是否应输出（两条路径统一判定） */
function shouldLog(level) {
    const value = LEVEL_BY_NAME[String(level).toUpperCase()]
    return value === undefined ? true : value >= activeLevel
}

/**
 * 设置全局日志级别（名称或数值，如 "info" / 2）。
 * 同时作用于 loglevel 路径与 logWithTag 家族。
 * @returns {boolean} 是否设置成功（非法值返回 false，且不改变当前级别）
 */
export function setLogLevel(level) {
    const normalized = normalizeLevel(level)
    if (normalized === null) return false
    activeLevel = normalized
    log.setLevel(normalized)
    return true
}

/** 当前日志级别数值 */
export function getLogLevel() {
    return activeLevel
}

/** 当前日志级别名称（如 "INFO"），供界面展示与持久化 */
export function getLogLevelName() {
    return Object.keys(LEVEL_BY_NAME).find((k) => LEVEL_BY_NAME[k] === activeLevel) || "INFO"
}

setupLogger()
// 默认 INFO：此前 loglevel 默认 WARN，引擎的 INFO 诊断全部被丢弃
log.setLevel(activeLevel)

let loggerName = ""
const nowDateStr = dayjs().format("YYYYMMDDHHmmss")

const levelColors = {
    TRACE: chalk.magenta,
    DEBUG: chalk.cyan,
    INFO: chalk.green,
    WARN: chalk.yellow,
    ERROR: chalk.red,
}

const msgColors = {
    TRACE: chalk.magenta,
    DEBUG: chalk.gray,
    INFO: chalk.white,
    WARN: chalk.yellow,
    ERROR: chalk.red,
}

/**
 * 应用自定义日志插件到logger对象
 * 为不同日志级别的消息添加颜色和对象检查功能
 * 重写logger的methodFactory方法，增强日志输出功能
 *
 * @param {Object} logger - loglevel logger实例
 * @param {Object} options - 配置选项
 * @param {boolean} options.inspectObject - 是否对对象参数使用util.inspect展开
 * @param {boolean} options.coloredMessage - 是否为消息添加颜色
 */
function applyCustomPlugin(logger, options = {}) {
    const originalFactory = logger.methodFactory

    // 重写methodFactory方法，为每个日志级别创建自定义的日志方法
    logger.methodFactory = (methodName, logLevel, loggerName) => {
        const rawMethod = originalFactory(methodName, logLevel, loggerName)

        return function () {
            // 获取对应日志级别的颜色函数
            const chalkFunc = msgColors[methodName.toUpperCase()]
            const messages = []
            // 汇聚用：未经 chalk 着色的原始参数（ANSI 色码不应进入界面日志）
            const rawArgs = []

            // 处理所有传入的参数
            for (let i = 0; i < arguments.length; i++) {
                let arg = arguments[i]
                rawArgs.push(arg)

                // 如果启用了对象检查且参数是对象，使用util.inspect展开对象
                if (options.inspectObject && typeof arg === "object") {
                    arg = util.inspect(arg, {
                        showHidden: false, // 不显示隐藏属性
                        depth: 3, // 展开深度为3层
                        colors: false, // 在util.inspect中不使用颜色，由chalk处理
                    })
                }

                // 如果启用了彩色消息，使用对应级别的颜色函数处理
                messages.push(options.coloredMessage ? chalkFunc(arg) : arg)
            }

            // 调用原始的日志方法输出处理后的消息
            rawMethod(...messages)
            // 汇聚到宿主（是否过滤由宿主决定，此处与 console 输出保持一致）。
            // loglevel-plugin-prefix 会把级别前缀与**首个参数拼接**（实测：
            // log.warn("x") → 实参为 ["WARN x"]）。级别已由 level 字段单独表达，
            // 故剥离首部的 "<级别> " 标记，避免面板里出现「WARN xxx」这类冗余前缀。
            const levelToken = methodName.toUpperCase()
            const joined = formatSinkArgs(rawArgs)
            const sinkMessage = joined.startsWith(`${levelToken} `)
                ? joined.slice(levelToken.length + 1)
                : joined
            const sinkTag = typeof loggerName === "string" ? loggerName : ""
            emitLogSink(levelToken, sinkTag, sinkMessage)
            // 与 logWithTag 家族一致地落盘：否则 loglevel 路径的 INFO/WARN
            // （如 ffmpeg_plan 的逐条元数据、file.js 的扫描统计）仍然只存在于 stdout
            fileLog(sinkMessage, sinkTag || "engine")
        }
    }

    // 注意：应用插件后需要调用setLevel方法来激活插件
    // logger.setLevel(logger.getLevel());
}

function setupLogger() {
    fs.mkdirsSync(getLogRootDir())
    applyCustomPlugin(log, { inspectObject: true, coloredMessage: true })
    prefix.reg(log)
    prefix.apply(log, {
        levelFormatter(level) {
            return level.toUpperCase()
        },
        nameFormatter(name) {
            return name || loggerName
        },
        timestampFormatter(date) {
            return date.toISOString()
        },
        format(level, name) {
            let msg = `${levelColors[level](level)}`
            if (name && name.trim().length > 0) msg += ` ${chalk.green(`${name}`)}`
            return msg
        },
    })
}

/**
 * 设置日志根目录（宿主用，如 Electron 主进程传入 app.getPath("logs")）
 *
 * 引擎默认写在系统临时目录（用户找不到、且可能被系统清理），宿主应改为应用日志目录。
 *
 * @param {string} dir 绝对路径；非法入参忽略
 * @returns {boolean} 是否生效
 */
export function setLogRootDir(dir) {
    if (typeof dir !== "string" || dir.trim().length === 0) return false
    logRootDir = path.resolve(dir)
    try {
        fs.mkdirsSync(logRootDir)
    } catch {
        // 目录不可创建时保留原值之外不做处理：日志主流程不允许因落盘路径失败而中断
        return false
    }
    return true
}

/**
 * 获取日志根目录路径
 * @returns {string} 日志根目录路径
 */
function getLogRootDir() {
    return logRootDir
}

const fileLogCache = new Map()

// ---------------------------------------------------------------------------
// 文件日志自动落盘
// ---------------------------------------------------------------------------
// 目标：不再等整个流程结束才写盘。出现异常 / Ctrl+C 时也能看到已有日志。
// 策略：
//   1) 条数阈值 —— 某日志文件缓存攒满 FILE_LOG_FLUSH_COUNT 条即触发一次落盘；
//   2) 时间阈值 —— 某日志文件缓存的「首条未落盘日志」进入超过
//      FILE_LOG_FLUSH_INTERVAL_MS 后，下一条新日志到来时随本地触发落盘；
//   3) 退出兜底 —— flushFileLogSync 由调用方挂在 exit / 信号 / 异常处理器上，
//      保证中断时剩余缓存全部同步写盘。
// 说明：惰性计时（有日志进来才检查），不设常驻定时器，无泄漏。
const FILE_LOG_FLUSH_COUNT = 64
const FILE_LOG_FLUSH_INTERVAL_MS = 2000
// name(日志文件路径) -> 该文件首条未落盘日志进入缓存的时间戳
const fileLogPendingSince = new Map()
// 串行化 async 落盘：appendFile 并发写同一文件会交错/双写，
// 用 promise 链保证同一时刻只有一次落盘在途。
let fileLogFlushChain = Promise.resolve()

/**
 * 获取文件日志的完整路径
 *
 * @param {string} logFileName - 日志文件名前缀，默认为"mediac"
 * @returns {string} 完整的日志文件路径
 */
export const fileLogPath = (logFileName = "mediac") => {
    const name = `${logFileName}_log_${nowDateStr}.txt`
    return path.resolve(path.join(getLogRootDir(), name))
}

/**
 * 将日志文本添加到文件日志缓存中
 * 日志会缓存在内存中，稍后通过flushFileLog写入文件
 *
 * @param {string} logText - 要记录的日志文本
 * @param {string} logTag - 日志标签，用于标识日志来源
 * @param {string} logFileName - 日志文件名（默认：mediac）
 */
/**
 * 记录日志到文件缓存
 * 将日志文本添加到文件日志缓存中，稍后通过flushFileLog写入文件
 *
 * @param {string} logText - 要记录的日志文本
 * @param {string} logTag - 日志标签，用于标识日志来源
 * @param {string} logFileName - 日志文件名（默认：mediac）
 */
export const fileLog = (logText, logTag = "", logFileName = "mediac") => {
    const dt = dayjs().format("HH:mm:ss.SSS") // 格式化当前时间为时分秒毫秒
    const name = fileLogPath(logFileName) // 获取完整的日志文件路径
    const cache = fileLogCache.get(name) || [] // 获取该日志文件的缓存数组，如果没有则创建空数组

    // 将格式化的日志条目添加到缓存
    cache.push(`[${dt}][${logTag}] ${logText}`)

    // 记录该文件「首条未落盘日志」的入缓存时间：达到时间阈值后随下一条日志落盘
    if (!fileLogPendingSince.has(name)) {
        fileLogPendingSince.set(name, Date.now())
    }

    // 更新缓存
    fileLogCache.set(name, cache)

    // 自动落盘：条数阈值立即触发；时间阈值由新日志带入（惰性），不设定时器
    const pendingAt = fileLogPendingSince.get(name)
    if (
        cache.length >= FILE_LOG_FLUSH_COUNT ||
        Date.now() - pendingAt >= FILE_LOG_FLUSH_INTERVAL_MS
    ) {
        fileLogPendingSince.delete(name)
        // 不 await：fileLog 是同步路径，落盘走 promise 链串行执行
        void flushFileLog()
    }
}

/**
 * 将缓存中的日志写入文件
 * 遍历fileLogCache，将所有缓存的日志条目写入对应文件
 * 通过 promise 链串行执行，避免并发写同一文件造成交错/双写
 */
export const flushFileLog = () => {
    const flushRun = async () => {
        for (const [key, value] of fileLogCache) {
            if (value.length === 0) {
                continue
            }
            // splice 取出当前缓存行并清空，避免与「写盘后清空」的旧语义冲突
            // （写盘期间新 push 进来的行留在数组里，随下一次 flush 写出）
            const lines = value.splice(0)
            try {
                // 每条日志自带换行：补齐多批次拼接时的行尾，避免粘连
                await fs.appendFile(key, lines.join("\n") + "\n", { encoding: "utf-8" })
                fileLogPendingSince.delete(key)
            } catch (error) {
                // 写失败放回缓存头部：下次 flush 重试，避免日志丢失
                value.unshift(...lines)
                log.show(error)
            }
        }
    }
    fileLogFlushChain = fileLogFlushChain.then(flushRun)
    return fileLogFlushChain
}

/**
 * 同步将缓存中的日志写入文件
 * 适用于进程退出 / 信号 / 未捕获异常等事件循环即将终止的场景：
 * 此时异步 flush 可能来不及完成，用 appendFileSync 保证剩余缓存全部落盘。
 */
export const flushFileLogSync = () => {
    for (const [key, value] of fileLogCache) {
        if (value.length === 0) {
            continue
        }
        const lines = value.splice(0)
        try {
            fs.appendFileSync(key, lines.join("\n") + "\n", { encoding: "utf-8" })
            fileLogPendingSince.delete(key)
        } catch (error) {
            value.unshift(...lines)
            log.show(error)
        }
    }
}

// 统一兜底：任何退出路径（正常结束 / process.exit / Ctrl+C 与 SIGTERM
// 经各模块 handler 转 exit）都会触发 exit 事件，同步落盘剩余缓存，
// 保证中途中断时已产生的文件日志不丢。
process.on("exit", () => {
    flushFileLogSync()
})

/**
 * 以灰色显示输出
 *
 * @param  {...*} args - 要输出的参数
 */
export const showGray = (...args) => {
    console.log(...args.map((a) => (typeof a === "object" ? a : chalk.gray(a))))
}

/**
 * 以红色显示输出
 *
 * @param  {...*} args - 要输出的参数
 */
export const showRed = (...args) => {
    console.log(...args.map((a) => (typeof a === "object" ? a : chalk.red(a))))
}

/**
 * 以绿色显示输出
 *
 * @param  {...*} args - 要输出的参数
 */
export const showGreen = (...args) => {
    console.log(...args.map((a) => (typeof a === "object" ? a : chalk.green(a))))
}

/**
 * 以黄色显示输出
 *
 * @param  {...*} args - 要输出的参数
 */
export const showYellow = (...args) => {
    console.log(...args.map((a) => (typeof a === "object" ? a : chalk.yellow(a))))
}

/**
 * 以蓝色显示输出
 *
 * @param  {...*} args - 要输出的参数
 */
export const showBlue = (...args) => {
    console.log(...args.map((a) => (typeof a === "object" ? a : chalk.blue(a))))
}

/**
 * 以洋红色显示输出
 *
 * @param  {...*} args - 要输出的参数
 */
export const showMagenta = (...args) => {
    console.log(...args.map((a) => (typeof a === "object" ? a : chalk.magenta(a))))
}

/**
 * 以青色显示输出
 *
 * @param  {...*} args - 要输出的参数
 */
export const showCyan = (...args) => {
    console.log(...args.map((a) => (typeof a === "object" ? a : chalk.cyan(a))))
}

/**
 * 以白色显示输出
 *
 * @param  {...*} args - 要输出的参数
 */
export const showWhite = (...args) => {
    console.log(...args.map((a) => (typeof a === "object" ? a : chalk.white(a))))
}

export const show = showWhite

export const LogLevel = Object.freeze({
    TRACE: 0,
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    SILENT: 5,
})

export const LogCategory = Object.freeze({
    START: { prefix: "START", color: chalk.cyan },
    END: { prefix: "END", color: chalk.cyan },
    DONE: { prefix: "DONE", color: chalk.green },
    OK: { prefix: "OK", color: chalk.green },
    SUCCESS: { prefix: "SUCCESS", color: chalk.green },
    SKIP: { prefix: "SKIP", color: chalk.yellow },
    WARN: { prefix: "WARN", color: chalk.yellow },
    ERROR: { prefix: "ERROR", color: chalk.red },
    FAIL: { prefix: "FAIL", color: chalk.red },
    INFO: { prefix: "INFO", color: chalk.white },
    DEBUG: { prefix: "DEBUG", color: chalk.gray },
    PROGRESS: { prefix: "PROGRESS", color: chalk.cyan },
    TASK: { prefix: "TASK", color: chalk.blue },
})

function formatLogTag(tag) {
    return tag && typeof tag === "string" ? `[${tag}]` : ""
}

function formatLogCategory(category) {
    if (!category) return ""
    const cat = typeof category === "string" ? LogCategory[category.toUpperCase()] : category
    if (!cat) return ""
    return cat.color(`[${cat.prefix}]`)
}

export function logWithTag(tag, category, ...args) {
    const key = typeof category === "string" ? category.toUpperCase() : category?.prefix
    const level = CATEGORY_LEVEL[key] || "INFO"
    // 统一级别判定：本家族此前完全不受 setLevel 控制，永远输出（见文件顶部说明）
    if (!shouldLog(level)) return
    const tagStr = formatLogTag(tag)
    const catStr = formatLogCategory(category)
    const prefix = [tagStr, catStr].filter(Boolean).join(" ")
    console.log(prefix, ...args.map((a) => (typeof a === "object" ? a : String(a))))
    const text = formatSinkArgs(args)
    // 汇聚到宿主（Electron 主进程 → 界面日志面板）
    emitLogSink(level, typeof tag === "string" ? tag : "", text)
    // 同时落盘：此前只有显式调用 fileLog 的少数位置才写文件，INFO/WARN 诊断从不落盘
    fileLog(text, typeof tag === "string" ? tag : "")
}

export function logSuccess(tag, ...args) {
    logWithTag(tag, LogCategory.SUCCESS, ...args)
}

export function logWarn(tag, ...args) {
    logWithTag(tag, LogCategory.WARN, ...args)
}

export function logError(tag, ...args) {
    logWithTag(tag, LogCategory.ERROR, ...args)
}

export function logSkip(tag, ...args) {
    logWithTag(tag, LogCategory.SKIP, ...args)
}

export function logProgress(tag, ...args) {
    logWithTag(tag, LogCategory.PROGRESS, ...args)
}

export function logTask(tag, index, total, ...args) {
    const progress = total > 0 ? `${index}/${total}` : `${index}`
    logWithTag(tag, LogCategory.TASK, chalk.cyan(progress), ...args)
}

export function logStart(tag, ...args) {
    logWithTag(tag, LogCategory.START, ...args)
}

export function logEnd(tag, ...args) {
    logWithTag(tag, LogCategory.END, ...args)
}

export function logDone(tag, ...args) {
    logWithTag(tag, LogCategory.DONE, ...args)
}

export function logInfo(tag, ...args) {
    logWithTag(tag, LogCategory.INFO, ...args)
}

export function logDebug(tag, ...args) {
    logWithTag(tag, LogCategory.DEBUG, ...args)
}

export function logFail(tag, ...args) {
    logWithTag(tag, LogCategory.FAIL, ...args)
}

/**
 * 输出trace级别日志
 *
 * @param  {...*} args - 要输出的参数
 */
export const trace = function () {
    log.trace(...arguments)
}

/**
 * 输出debug级别日志
 *
 * @param  {...*} args - 要输出的参数
 */
export const debug = function () {
    log.debug(...arguments)
}

/**
 * 输出info级别日志
 *
 * @param  {...*} args - 要输出的参数
 */
export const info = function () {
    log.info(...arguments)
}

/**
 * 输出warn级别日志
 *
 * @param  {...*} args - 要输出的参数
 */
export const warn = function () {
    log.warn(...arguments)
}

/**
 * 输出error级别日志
 *
 * @param  {...*} args - 要输出的参数
 */
export const error = function () {
    log.error(...arguments)
}

/**
 * 设置日志详细程度
 * level值越大，输出越详细
 *
 * @param {number} level - 详细程度级别
 */
export const setVerbose = (level) => setLogLevel(Math.max(0, LEVEL_BY_NAME.WARN - level))

/**
 * 设置日志级别（兼容旧签名：数值；现同时作用于两条日志路径）
 *
 * @param {number|string} lvl - 日志级别（数值或名称）
 */
export const setLevel = (lvl) => setLogLevel(lvl)

/**
 * 获取当前日志级别
 *
 * @returns {number} 日志级别
 */
export const getLevel = () => activeLevel

/**
 * 检查是否处于详细模式（INFO及以上）
 *
 * @returns {boolean} 如果是详细模式返回true
 */
export const isVerbose = () => activeLevel <= LEVEL_BY_NAME.INFO

/**
 * 设置日志记录器名称
 *
 * @param {string} name - 日志名称
 */
export const setName = (name) => (loggerName = name)

/**
 * 测量函数执行时间的装饰器
 * @param {Function} fn - 要测量的函数
 * @param {string} [label] - 可选标签，默认为函数名
 * @returns {Function} - 包装后的函数
 */
export const measure = (fn, label) => {
    return function (...args) {
        const name = label || fn.name || "anonymous"
        const start = Date.now()
        let result
        try {
            result = fn.apply(this, args)
        } catch (error) {
            const end = Date.now()
            showRed(`[Timer] ${name} (Error): ${end - start}ms`)
            throw error
        }

        if (result && typeof result.then === "function") {
            return result
                .then((res) => {
                    const end = Date.now()
                    showCyan(`[Timer] ${name}: ${end - start}ms`)
                    return res
                })
                .catch((err) => {
                    const end = Date.now()
                    showRed(`[Timer] ${name} (Error): ${end - start}ms`)
                    throw err
                })
        } else {
            const end = Date.now()
            showCyan(`[Timer] ${name}: ${end - start}ms`)
            return result
        }
    }
}
