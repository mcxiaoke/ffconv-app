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

/** 带 GPU 矩阵代次的 N 卡 caps（gen 见 gpu.js NVIDIA_GEN：30=Ampere，40=Ada） */
function nvidiaCapsOfGeneration(generation) {
    const caps = nvidiaCaps()
    caps.gpus = [{ vendor: "nvidia", model: "RTX", generation }]
    caps.gpuProbe = { vendor: "nvidia", model: "RTX", generation, arch: `gen${generation}` }
    return caps
}

test("编码侧预筛：预 Ada 的 N 卡跑 AV1 → 所有 NVENC 层被跳过，回落 cpu", () => {
    const plan = resolvePreviewHwPlan({
        caps: nvidiaCapsOfGeneration(30), // Ampere：NVENC 无 AV1 编码
        codecFamily: "av1",
    })
    assert.equal(plan.tier.name, "cpu")
    // cuda / swdec / d3d 三层都用 *_nvenc 被跳过；cpu 层用 libsvtav1 不受影响，正常入选
    assert.deepEqual(plan.tried, ["cuda", "swdec", "d3d", "cpu"])
    assert.equal(plan.degraded, true)
})

test("编码侧预筛：Ada(40 系) 起支持 AV1 编码 → 仍取 cuda", () => {
    const plan = resolvePreviewHwPlan({
        caps: nvidiaCapsOfGeneration(40),
        codecFamily: "av1",
    })
    assert.equal(plan.tier.name, "cuda")
})

test("编码侧预筛不影响 h264/hevc（NVENC 全代次支持 yuv420p）", () => {
    for (const family of ["h264", "hevc"]) {
        const plan = resolvePreviewHwPlan({
            caps: nvidiaCapsOfGeneration(30),
            codecFamily: family,
        })
        assert.equal(plan.tier.name, "cuda", `${family} 不应被编码预筛拦下`)
    }
})

test("无 gpuProbe 代次时不启用编码侧预筛（不误伤）", () => {
    // nvidiaCaps() 无 gpuProbe → 拿不到代次，编码矩阵无从查表
    const plan = resolvePreviewHwPlan({ caps: nvidiaCaps(), codecFamily: "av1" })
    assert.equal(plan.tier.name, "cuda")
})