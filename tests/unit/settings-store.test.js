import test from "node:test"
import assert from "node:assert/strict"
import { sanitizeSettings, defaultSettings } from "../../src/main/settings-store.ts"

test("缺少载荷时回落到默认值", () => {
    const d = defaultSettings()
    assert.equal(d.preset, "hevc_2k")
    assert.equal(d.outputMode, "dir")
    assert.equal(d.adv.jobs, 1)

    const s = sanitizeSettings(undefined)
    assert.deepEqual(s, d)
    // 非对象（数组/字符串/数字）同样回落
    assert.deepEqual(sanitizeSettings([]), d)
    assert.deepEqual(sanitizeSettings("x"), d)
    assert.deepEqual(sanitizeSettings(42), d)
})

test("未知字段一律丢弃：deleteSource 绝不落盘", () => {
    const s = sanitizeSettings({
        preset: "h264_2k",
        deleteSource: true,
        evilField: "x",
        adv: { jobs: 2, deleteSource: true, anotherUnknown: 1 },
    })
    assert.equal(s.preset, "h264_2k")
    assert.equal(s.adv.jobs, 2)
    assert.equal("deleteSource" in s, false)
    assert.equal("evilField" in s, false)
    assert.equal("deleteSource" in s.adv, false)
    assert.equal("anotherUnknown" in s.adv, false)
    // 整份序列化里也不应出现
    assert.equal(JSON.stringify(s).includes("deleteSource"), false)
})

test("数值被收窄到合法区间", () => {
    assert.equal(sanitizeSettings({ adv: { jobs: 999 } }).adv.jobs, 8)
    assert.equal(sanitizeSettings({ adv: { jobs: 0 } }).adv.jobs, 1)
    assert.equal(sanitizeSettings({ adv: { jobs: -5 } }).adv.jobs, 1)
    assert.equal(sanitizeSettings({ adv: { jobs: 2.6 } }).adv.jobs, 3)

    assert.equal(sanitizeSettings({ tune: { quality: 99 } }).tune.quality, 51)
    assert.equal(sanitizeSettings({ tune: { quality: -1 } }).tune.quality, 0)
    assert.equal(sanitizeSettings({ tune: { dimension: 99999 } }).tune.dimension, 16384)
    assert.equal(sanitizeSettings({ tune: { fps: 999 } }).tune.fps, 240)
    assert.equal(sanitizeSettings({ tune: { speed: 99 } }).tune.speed, 4)
})

test("非法枚举回落到基准值", () => {
    assert.equal(sanitizeSettings({ outputMode: "bogus" }).outputMode, "dir")
    assert.equal(sanitizeSettings({ outputMode: "tree" }).outputMode, "tree")
    assert.equal(sanitizeSettings({ adv: { hwaccel: "vulkan" } }).adv.hwaccel, "auto")
    assert.equal(sanitizeSettings({ adv: { hwaccel: "qsv" } }).adv.hwaccel, "qsv")
    assert.equal(sanitizeSettings({ adv: { decodeMode: "half" } }).adv.decodeMode, "auto")
})

test("字符串截断到上限", () => {
    const long = "x".repeat(5000)
    assert.equal(sanitizeSettings({ preset: long }).preset.length, 4096)
    assert.equal(sanitizeSettings({ outputDir: long }).outputDir.length, 4096)
    assert.equal(sanitizeSettings({ prefix: long }).prefix.length, 4096)
})

test("以 base 为底合并：未提供的字段保留 base 现值", () => {
    const base = {
        ...defaultSettings(),
        preset: "av1_2k",
        outputMode: "tree",
        adv: { ...defaultSettings().adv, jobs: 3 },
    }
    const s = sanitizeSettings({ prefix: "P_" }, base)
    assert.equal(s.prefix, "P_")
    assert.equal(s.preset, "av1_2k")
    assert.equal(s.outputMode, "tree")
    assert.equal(s.adv.jobs, 3)
})

test("布尔字段只接受真正的布尔值", () => {
    assert.equal(sanitizeSettings({ outputBesideSource: false }).outputBesideSource, false)
    assert.equal(sanitizeSettings({ outputBesideSource: "false" }).outputBesideSource, true)
    assert.equal(sanitizeSettings({ adv: { override: true } }).adv.override, true)
    assert.equal(sanitizeSettings({ adv: { override: 1 } }).adv.override, false)
})