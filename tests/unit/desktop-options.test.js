import test from "node:test"
import assert from "node:assert/strict"
import { normalizeDesktopOptions } from "../../core/transcode/ffmpeg_options.js"

/**
 * P2-1 收口回归：desktop（IPC）入口不得采信渲染层传来的
 * errorFile（任意路径 appendFile 原语）与 deleteSourceConfirmed / autoConfirm
 * （删源确认位只能由主进程原生确认框置位）。
 * 渲染层传什么都必须被剥离，即使是合法值也一样 —— 确认位由 ffmpeg-service 在
 * 原生确认通过后自行覆盖为 true，不走这个入口。
 */
test("desktop 入口剥离 errorFile（含 options 内嵌与顶层两种注入位置）", () => {
    const viaOptions = normalizeDesktopOptions({
        mode: "execute",
        inputs: ["D:/media/movie.mkv"],
        output: "D:/out",
        options: { errorFile: "C:/Users/x/AppData/evil.txt" },
    })
    assert.ok(!("errorFile" in viaOptions))

    const viaTopLevel = normalizeDesktopOptions({
        mode: "execute",
        inputs: ["D:/media/movie.mkv"],
        output: "D:/out",
        errorFile: "C:/Users/x/AppData/evil.txt",
    })
    assert.ok(!("errorFile" in viaTopLevel))
})

test("desktop 入口剥离 deleteSourceConfirmed / autoConfirm", () => {
    const normalized = normalizeDesktopOptions({
        mode: "execute",
        inputs: ["D:/media/movie.mkv"],
        output: "D:/out",
        options: {
            deleteSourceConfirmed: true,
            autoConfirm: true,
            deleteSourceFiles: true,
        },
    })
    assert.equal(normalized.deleteSourceConfirmed, false)
    assert.equal(normalized.autoConfirm, false)
    // 意图字段本身保留，由主进程弹原生确认框后处置
    assert.equal(normalized.deleteSourceFiles, true)
})

test("desktop 入口剥离不影响合法选项的归一化", () => {
    const normalized = normalizeDesktopOptions({
        mode: "execute",
        inputs: ["D:/media/movie.mkv"],
        output: "D:/out",
        options: { outputMode: "file", decodeMode: "gpu", jobs: 4, anime: true },
    })
    assert.equal(normalized.outputMode, "file")
    assert.equal(normalized.decodeMode, "gpu")
    assert.equal(normalized.jobs, 4)
    assert.equal(normalized.anime, true)
})
