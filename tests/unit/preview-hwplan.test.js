import test from "node:test"
import assert from "node:assert/strict"
import { resolvePreviewHwPlan } from "../../core/transcode/hwaccel.js"

/**
 * 构造一台「N 卡 + 可用 NVENC/NVDEC」的 caps，形状与 detectHardwareCapabilities 一致。
 * auto 候选链预期为 [cuda, swdec, d3d, cpu]（见 hwdetect.js candidateTiers）。
 */
function nvidiaCaps() {
    return {
        vendor: "nvidia",
        gpus: [{ vendor: "nvidia", model: "RTX 4070", generation: 40 }],
        encoders: new Set(["h264_nvenc", "hevc_nvenc", "av1_nvenc"]),
        hwaccels: ["cuda", "d3d11va", "d3d12va"],
        usable: { cuda: true, qsv: false, amf: false, d3d: true, cpu: true },
        filterSupport: { scale_cuda: true, scale_qsv: false, vpp_amf: false },
    }
}

test("能力级预览：N 卡机器取 cuda 作为预计层，而不是 cpu", () => {
    const plan = resolvePreviewHwPlan({ caps: nvidiaCaps() })
    assert.equal(plan.tier.name, "cuda")
    assert.equal(plan.size, null)
    assert.equal(plan.degraded, false)
    assert.deepEqual(plan.tried, ["cuda"])
    // hwFormat/hwaccel 决定命令里的 -hwaccel / -hwaccel_output_format
    assert.equal(plan.tier.hwaccel, "cuda")
    assert.equal(plan.tier.hwFormat, "cuda")
    assert.match(plan.reason, /no per-file ffmpeg probe/)
})

test("decodeMode=cpu 时预计层为 cpu", () => {
    const plan = resolvePreviewHwPlan({ caps: nvidiaCaps(), decodeMode: "cpu" })
    assert.equal(plan.tier.name, "cpu")
})

test("音频文件与音频预设都回落 cpu（与 resolveHwPlan 同口径）", () => {
    const byExt = resolvePreviewHwPlan({ caps: nvidiaCaps(), path: "D:\\media\\song.mp3" })
    assert.equal(byExt.tier.name, "cpu")
    assert.match(byExt.reason, /audio/)

    const byPreset = resolvePreviewHwPlan({
        caps: nvidiaCaps(),
        path: "D:\\media\\movie.mp4",
        presetType: "audio",
    })
    assert.equal(byPreset.tier.name, "cpu")
    assert.match(byPreset.reason, /audio/)
})

test("caps 缺失时回落 cpu 且不抛错", () => {
    const plan = resolvePreviewHwPlan({ caps: null })
    assert.equal(plan.tier.name, "cpu")
    assert.match(plan.reason, /caps unavailable/)
})

test("caps 形状异常（无 usable）时被捕获并回落 cpu，绝不抛错", () => {
    // candidateTiers 会在读取 caps.usable[t] 时抛错；预览必须吞掉异常
    let plan
    assert.doesNotThrow(() => {
        plan = resolvePreviewHwPlan({ caps: {} })
    })
    assert.equal(plan.tier.name, "cpu")
    assert.match(plan.reason, /cpu/i)
})

test("decodeMode=gpu 但指定层不可用时回落 cpu，绝不抛错", () => {
    let plan
    assert.doesNotThrow(() => {
        plan = resolvePreviewHwPlan({
            caps: nvidiaCaps(),
            decodeMode: "gpu",
            hwaccel: "qsv", // 该机器 usable.qsv=false → resolveTiers 抛错
        })
    })
    assert.equal(plan.tier.name, "cpu")
    assert.match(plan.reason, /fallback|cpu/i)
})

test("合法 decodeMode=gpu + hwaccel 时取该层", () => {
    const plan = resolvePreviewHwPlan({
        caps: nvidiaCaps(),
        decodeMode: "gpu",
        hwaccel: "cuda",
    })
    assert.equal(plan.tier.name, "cuda")
})

test("返回值形状与 resolveHwPlan 一致（tier/size/degraded/tried/reason/caps）", () => {
    const caps = nvidiaCaps()
    const plan = resolvePreviewHwPlan({ caps })
    for (const key of ["tier", "size", "degraded", "tried", "reason", "caps"]) {
        assert.equal(key in plan, true, `缺少字段 ${key}`)
    }
    assert.equal(plan.caps, caps)
})