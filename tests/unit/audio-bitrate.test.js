import test from "node:test"
import assert from "node:assert/strict"
import { calculateDstArgs } from "../../core/transcode/ffmpeg_plan.js"

/**
 * P0-4 回归：smartBitrate=true 的预设此前会**无视**显式声明的 audioBitrate，
 * 智能码率总是胜出 —— aac_high(256k)/medium(192k)/low(128k)/he(96k) 只覆盖
 * audioBitrate 而继承基类 `_base_aac_cbr` 的 smartBitrate:true，
 * 对 320K 源一律产出 320K，且 suffix "_{audioBitrateK}" 把错误码率写进文件名。
 * 修复后的优先级：显式声明（userArgs > 预设）> smartBitrate > 0。
 */
function audioEntry(presetOverrides = {}, userArgs = {}) {
    return {
        path: "D:/media/song.m4a",
        name: "song.m4a",
        info: { bitrate: 320 * 1000, audio: { format: "aac", bitrate: 320 * 1000 } },
        format: { bitrate: 320 * 1000 },
        preset: {
            type: "audio",
            format: ".m4a",
            ...presetOverrides,
            userArgs: { ...userArgs },
        },
    }
}

test("预设声明 audioBitrate=128k + smartBitrate=true：声明的 128k 必须胜出", () => {
    const dst = calculateDstArgs(
        audioEntry({ smartBitrate: true, audioBitrate: 128 * 1000 }),
    )
    assert.equal(dst.dstAudioBitrate, 128 * 1000)
    assert.equal(dst.audioBitrateK, "128K")
})

test("aac_he 类场景：声明 96k + 320K 源，不得被智能档位顶成 320K", () => {
    const dst = calculateDstArgs(
        audioEntry({ smartBitrate: true, audioBitrate: 96 * 1000 }),
    )
    assert.equal(dst.dstAudioBitrate, 96 * 1000)
})

test("smartBitrate=true 且未声明码率：按智能档位取值（行为不变）", () => {
    // bitrateMap 的命中条件是严格大于（src > 320k 才取 320k 档），384k 源 → 320k 档
    const dst = calculateDstArgs({
        path: "D:/media/song.m4a",
        name: "song.m4a",
        info: { bitrate: 384 * 1000, audio: { format: "aac", bitrate: 384 * 1000 } },
        format: { bitrate: 384 * 1000 },
        preset: { type: "audio", format: ".m4a", smartBitrate: true, userArgs: {} },
    })
    assert.equal(dst.dstAudioBitrate, 320 * 1000)
    // 320k 源本身落在 256k 档（严格大于语义，行为保持）
    const at320 = calculateDstArgs(audioEntry({ smartBitrate: true }))
    assert.equal(at320.dstAudioBitrate, 256 * 1000)
})

test("smartBitrate=false + 声明 192k：直接用声明值（行为不变）", () => {
    const dst = calculateDstArgs(
        audioEntry({ smartBitrate: false, audioBitrate: 192 * 1000 }),
    )
    assert.equal(dst.dstAudioBitrate, 192 * 1000)
})

test("用户 userArgs.audioBitrate 优先级最高，覆盖预设声明与智能码率", () => {
    const dst = calculateDstArgs(
        audioEntry({ smartBitrate: true, audioBitrate: 256 * 1000 }, { audioBitrate: 64 * 1000 }),
    )
    assert.equal(dst.dstAudioBitrate, 64 * 1000)
})

test("目标码率不得高于源码率（minNoZero 夹取保持）", () => {
    // 源 96k、声明 128k → 夹到 96k
    const dst = calculateDstArgs({
        path: "D:/media/song.m4a",
        name: "song.m4a",
        info: { bitrate: 96 * 1000, audio: { format: "aac", bitrate: 96 * 1000 } },
        format: { bitrate: 96 * 1000 },
        preset: { type: "audio", format: ".m4a", smartBitrate: false, audioBitrate: 128 * 1000, userArgs: {} },
    })
    assert.equal(dst.dstAudioBitrate, 96 * 1000)
})

test("源码率读不到且非无损：dstAudioBitrate 走 48k 兜底（行为不变）", () => {
    const dst = calculateDstArgs({
        path: "D:/media/song.m4a",
        name: "song.m4a",
        info: { audio: { format: "aac" } },
        format: {},
        preset: { type: "audio", format: ".m4a", smartBitrate: true, userArgs: {} },
    })
    assert.equal(dst.dstAudioBitrate, 48 * 1000)
})
