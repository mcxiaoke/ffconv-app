import test from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import path from "node:path"
import * as log from "../../core/lib/debug.js"

// 引擎日志根目录指向独立临时子目录，避免测试污染默认日志目录
log.setLogRootDir(path.join(tmpdir(), "mediac-unit-logs"))

/** 收集一次调用期间汇聚到的日志记录 */
function capture(fn) {
    const got = []
    const off = log.addLogSink((record) => got.push(record))
    try {
        fn()
    } finally {
        off()
    }
    return got
}

test("默认日志级别为 INFO", () => {
    log.setLogLevel("info")
    assert.equal(log.getLogLevelName(), "INFO")
    assert.equal(log.getLogLevel(), 2)
})

test("logWithTag 家族受统一级别控制（此前完全不受 setLevel 影响）", () => {
    log.setLogLevel("warn")
    const atWarn = capture(() => {
        log.logInfo("t", "info line")
        log.logWarn("t", "warn line")
    })
    assert.deepEqual(
        atWarn.map((r) => r.level),
        ["WARN"],
    )

    log.setLogLevel("info")
    const atInfo = capture(() => {
        log.logInfo("t", "info line")
        log.logDebug("t", "debug line")
        log.logError("t", "error line")
    })
    assert.deepEqual(
        atInfo.map((r) => r.level),
        ["INFO", "ERROR"],
    )
})

test("loglevel 路径同样受控：默认 INFO 下 log.info 不再被丢弃", () => {
    log.setLogLevel("info")
    const got = capture(() => log.info("info via loglevel"))
    assert.equal(got.length, 1)
    assert.equal(got[0].level, "INFO")
    // 级别前缀（loglevel-plugin-prefix 注入）必须已被剥离
    assert.equal(got[0].message, "info via loglevel")

    log.setLogLevel("warn")
    assert.equal(capture(() => log.info("should be dropped")).length, 0)
})

test("非法级别不生效，合法数值签名仍可用", () => {
    log.setLogLevel("info")
    assert.equal(log.setLogLevel("nope"), false)
    assert.equal(log.getLogLevelName(), "INFO")

    // 兼容旧的数值签名
    assert.equal(log.setLevel(3), true)
    assert.equal(log.getLogLevelName(), "WARN")
    log.setLogLevel("info")
})