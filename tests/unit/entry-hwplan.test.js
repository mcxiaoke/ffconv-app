import test from "node:test"
import assert from "node:assert/strict"
import { resolveEntryHwPlan } from "../../core/transcode/ffmpeg_run.js"

/**
 * resolveEntryHwPlan 是执行期与宿主「实测」共用的分层入口。
 * 这里只覆盖**不触发 ffmpeg 干跑**的短路分支（音频 / video copy / 已取消），
 * 需要 probeLayer 的路径属真机探测范畴，不放进单元测试。
 */
function nvidiaCaps() {
    return {
        vendor: "nvidia",
        gpus: [{ vendor: "nvidia", model: "RTX 4070", generation: 40 }],
        encoders: new Set(["h264_nvenc", "hevc_nvenc"]),
        hwaccels: ["cuda", "d3d11va"],
        usable: { cuda: true, qsv: false, amf: false, d3d: true, cpu: true },
        filterSupport: { scale_cuda: true, scale_qsv: false, vpp_amf: false },
    }
}

test("音频文件不探测分层，直接 cpu 占位", async () => {
    const plan = await resolveEntryHwPlan(
        { path: "D:\\media\\song.mp3", info: { audio: { format: "mp3" } }, preset: { type: "video" }, argv: {} },
        { caps: nvidiaCaps() },
    )
    assert.equal(plan.tier.name, "cpu")
    assert.deepEqual(plan.tried, ["cpu"])
    assert.equal(plan.reason, "audio file")
})

test("音频预设（video 缺失）同样 cpu 占位", async () => {
    const plan = await resolveEntryHwPlan(
        { path: "D:\\media\\movie.mp4", info: { audio: { format: "aac" } }, preset: { type: "audio" }, argv: {} },
        { caps: nvidiaCaps() },
    )
    assert.equal(plan.tier.name, "cpu")
    assert.equal(plan.reason, "audio preset")
})

test("video copy 不重编码：cpu 占位，且回传 caps / decodeMode", async () => {
    const caps = nvidiaCaps()
    const plan = await resolveEntryHwPlan(
        {
            path: "D:\\media\\movie.mp4",
            info: { video: { width: 1920, height: 1080, format: "h264" } },
            preset: { type: "video", userArgs: { videoCodec: "copy" } },
            argv: { decodeMode: "auto" },
        },
        { caps },
    )
    assert.equal(plan.tier.name, "cpu")
    assert.match(plan.reason, /copy/)
    assert.equal(plan.caps, caps)
    assert.equal(plan.decodeMode, "auto")
})

test("已取消的 signal 立即抛 AbortError，不进入探测", async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
        () =>
            resolveEntryHwPlan(
                { path: "D:\\media\\movie.mp4", info: {}, preset: { type: "video" }, argv: {} },
                { caps: nvidiaCaps(), signal: controller.signal },
            ),
        (err) => err.name === "AbortError",
    )
})
