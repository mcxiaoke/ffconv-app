import test from "node:test"
import assert from "node:assert/strict"
import { appendSubtitleArgs } from "../../core/transcode/ffmpeg_tags.js"

/**
 * P0-1 回归：外挂字幕分支此前只映射 `-map 0:v` + `-map 1:0?`（字幕流），
 * 缺 `-map 0:a?` —— ffmpeg 出现任意 -map 即切手动流选择，源的全部音轨被
 * 静默丢弃，产物无声（真机复现：双音轨 mkv + 同名 .srt → 产物 0 条音频流）。
 */
function videoEntry(overrides = {}) {
    return {
        path: "D:/media/movie.mkv",
        name: "movie.mkv",
        fileDst: "D:/media/out/movie.mkv",
        // 绝对视频流序号：pushStreamMaps 依赖它输出整组 -map
        info: { video: { streamIndex: 0 }, subtitles: [] },
        ...overrides,
    }
}

function buildArgs(entry, presetFormat = ".mkv") {
    const args = []
    appendSubtitleArgs(entry, args, { type: "video", format: presetFormat })
    return args
}

test("外挂字幕：argv 必须包含 -map 0:a?（音频流不得丢失）", () => {
    const args = buildArgs(videoEntry({ selectedSubtitle: "D:/media/movie.srt" }))
    const idx = args.indexOf("-map")
    assert.notEqual(idx, -1, "外挂字幕分支必须输出 -map 组")
    assert.ok(args.includes("0:a?"), `argv 缺少 -map 0:a?: ${args.join(" ")}`)
    assert.ok(args.includes("1:0?"), `argv 缺少字幕流 -map 1:0?: ${args.join(" ")}`)
})

test("外挂字幕映射到 MP4（mov_text）同样保留 -map 0:a?", () => {
    const entry = videoEntry({
        selectedSubtitle: "D:/media/movie.srt",
        fileDst: "D:/media/out/movie.mp4",
    })
    const args = buildArgs(entry, ".mp4")
    assert.ok(args.includes("0:a?"), `argv 缺少 -map 0:a?: ${args.join(" ")}`)
    assert.ok(args.includes("mov_text"))
})

test("内嵌字幕分支（MKV copy）仍带 -map 0:a?（防回归）", () => {
    const args = buildArgs(
        videoEntry({ info: { video: { streamIndex: 0 }, subtitles: [{ format: "subrip" }] } }),
    )
    assert.ok(args.includes("0:a?"))
    assert.ok(args.includes("0:s?"))
})

test("音频预设不参与流映射（不追加任何 -map 0:a?）", () => {
    const entry = videoEntry({ selectedSubtitle: "D:/media/movie.srt" })
    const args = []
    appendSubtitleArgs(entry, args, { type: "audio", format: ".m4a" })
    assert.equal(args.length, 0, "音频预设应整体跳过字幕/流映射逻辑")
})

test("取不到视频流序号时不输出任何 -map（整组省略，走 ffmpeg 默认选择）", () => {
    const entry = videoEntry({ selectedSubtitle: "D:/media/movie.srt" })
    entry.info.video.streamIndex = undefined
    const args = buildArgs(entry)
    assert.equal(args.filter((a) => a === "-map").length, 0)
})
