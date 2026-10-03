/**
 * FFmpeg 字幕流降级映射与元数据标签参数模块
 *
 * 包含：
 *   1. 字幕格式识别（位图 PGS/VobSub 检测、MKV/MP4/WebM 容器字幕降级与流映射）；
 *   2. 音频元数据标签清洗、纯净标题生成与 MKV 过期统计标签清除（防止 MediaInfo 误读旧码率）。
 */
import path from "path"
import * as core from "../lib/core.js"
import * as enc from "../lib/encoding.js"
import * as helper from "../lib/helper.js"
import * as log from "../lib/debug.js"

export const BITMAP_SUBTITLE_FORMATS = new Set([
    "hdmv_pgs_subtitle",
    "pgs",
    "dvd_subtitle",
    "vobsub",
    "dvb_subtitle",
    "dvb_teletext",
    "xsub",
    "arib_caption",
])

export function isBitmapSubtitle(sub) {
    const fmt = (sub?.format || "").toLowerCase()
    const codec = (sub?.codec || "").toLowerCase()
    return BITMAP_SUBTITLE_FORMATS.has(fmt) || BITMAP_SUBTITLE_FORMATS.has(codec)
}

/**
 * 视频流选择参数。
 *
 * ⚠️ 必须用**绝对流序号**（`0:<idx>`）而不是 `0:v:0`。
 * `v:0` 指「第 0 个 video 类型流」，而 ffprobe/mediainfo 把内嵌封面也报成 video：
 * 带封面的 MKV 实测封面 = stream0、真实视频 = stream1，于是 `-map 0:v:0`
 * 选中封面，产物是 1 帧静态图、ffmpeg 退出码却是 0（真机复现）。
 * 绝对序号来自 media_parser 的 resolveStreamIndex（见 looksLikeCoverArt 注释）。
 *
 * 取不到序号时返回 null：此时**一条 -map 都不能给**。ffmpeg 只要出现任意 -map 就会
 * 切到「手动流选择」，若只给 `-map 0:a?` 而不给视频，实测 ffmpeg 会自动补上
 * stream0（= 封面）作为视频流，封面又回来了。完全不给 -map 时 ffmpeg 走默认选择，
 * 实测默认选择本身就跳过 attached_pic。
 *
 * @param {object} entry
 * @returns {string[]|null}
 */
function videoStreamMapArgs(entry) {
    const idx = entry?.info?.video?.streamIndex
    return Number.isInteger(idx) && idx >= 0 ? ["-map", `0:${idx}`] : null
}

/** 封面/序号缺失时的一次性告警（同一文件只提示一次，避免刷屏） */
const warnedStreamIndex = new WeakSet()

function warnNoStreamIndex(entry) {
    if (!entry || typeof entry !== "object") return
    if (warnedStreamIndex.has(entry)) return
    warnedStreamIndex.add(entry)
    log.logWarn(
        "FFConv",
        `Cannot resolve the absolute video stream index of ${entry.name || entry.path || "?"}; ` +
            "falling back to ffmpeg default stream selection (may drop extra audio/subtitle tracks)",
    )
}

// 针对 MKV、MP4 及图形字幕降级的预定义字幕与流映射模板
// 注意：视频流映射由 videoStreamMapArgs 动态给出（见其注释），此处只放其余部分。
export const SUB_ARGS_MKV = ["-c:s", "copy", "-map", "0:a?", "-map", "0:s?"]
export const SUB_ARGS_MP4 = ["-c:s", "mov_text", "-map", "0:a?", "-map", "0:s?"]
export const SUB_ARGS_MP4_DROP = ["-sn", "-map", "0:a?"]

/**
 * 把「视频流绝对序号 + 音频/字幕流映射」整体压入参数数组。
 *
 * 视频流的绝对序号取不到时，**整组 -map 都不输出**（ffmpeg 走默认流选择，
 * 实测默认选择会正确跳过 attached_pic），而不是只输出音频/字幕的 -map ——
 * 后者会让 ffmpeg 手动选择并自动补回 stream0（封面）。详见 videoStreamMapArgs。
 *
 * @param {object} entry
 * @param {string[]} inputArgs 原地追加
 * @param {string[]} tail 视频流之后要跟的参数（`-map 0:a?` 等）
 */
function pushStreamMaps(entry, inputArgs, tail) {
    const videoMap = videoStreamMapArgs(entry)
    if (!videoMap) {
        warnNoStreamIndex(entry)
        return
    }
    inputArgs.push(...videoMap, ...tail)
}

/**
 * 附加字幕与流映射参数（预定义模板驱动）：
 * - 优先使用外部选中的字幕；
 * - MKV 容器使用 -c:s copy 完整保留所有字幕（文本/图形）；
 * - MP4 容器文本字幕转 -c:s mov_text，检测到图形字幕（PGS/VobSub）时容错使用 -sn；
 * - 视频流用**绝对序号**映射（见 videoStreamMapArgs），音频/字幕保留全部轨道。
 *
 * ⚠️ 只对**视频预设**生效。音频类预设（含从视频提取音频的 `audio_extract`）
 * 不能参与：它的 streamArgs 自带 `-vn -map 0:a:0`，若这里再插一组
 * `-map 0:a?` 就会映射两次，实测产物出现两条一模一样的重复音轨。
 * @param {Object} entry - 文件对象
 * @param {string[]} inputArgs - 正在构建的输入参数数组（原地追加）
 * @param {Object} tempPreset - 预设副本
 */
export function appendSubtitleArgs(entry, inputArgs, tempPreset) {
    // 仅视频预设处理字幕与视频流映射。
    // 旧条件是 `type !== "video" && !isVideoFile(path)`：audio_extract（type=audio）
    // 作用于 .mp4 时 isVideoFile 为真 → 条件为 false → 不早退，继续插入 -map 0:a?，
    // 与预设自带的 `-map 0:a:0` 叠加成重复音轨（真机复现）。
    // 正确判据只有预设类型：非视频预设一律不碰流映射。
    if (tempPreset.type !== "video") {
        return
    }

    const extRaw =
        path.extname(entry.fileDst || "") || tempPreset.format || helper.pathExt(entry.path) || ""
    const extLower = extRaw.toLowerCase()
    const isMkv = extLower.includes("mkv")

    // WebM 虽是 Matroska 子集，但字幕仅支持 WebVTT：
    // srt/ass 走 mkv 的 -c:s copy 或 MP4 的 mov_text 都会被 muxer 拒绝（实测：
    // "Only VP8/VP9/AV1 video and Vorbis or Opus audio and WebVTT subtitles are supported"）。
    // 与 MP4 位图字幕同样降级为 -sn 丢弃并告警（外挂字幕同理不挂载）。
    if (extLower.includes("webm")) {
        const hasSubs =
            Boolean(entry.selectedSubtitle) ||
            (Array.isArray(entry.info?.subtitles) && entry.info.subtitles.length > 0)
        if (hasSubs) {
            log.logWarn(
                "FFConv",
                "WebM container supports WebVTT subtitles only; dropping subtitles with -sn",
            )
        }
        pushStreamMaps(entry, inputArgs, SUB_ARGS_MP4_DROP)
        return
    }

    // 1. 外挂字幕：优先挂载外挂文件并映射
    if (entry.selectedSubtitle) {
        const subCodec = isMkv ? "copy" : "mov_text"
        inputArgs.push(
            "-i",
            entry.selectedSubtitle,
            "-c:s",
            subCodec,
            "-metadata:s:s:0",
            "language=chi",
            "-disposition:s:0",
            "default",
        )
        // ⚠️ 必须带 `-map 0:a?`：ffmpeg 只要出现任意 -map 就切到手动流选择，
        // 只映射视频+字幕（`0:<idx>` + `1:0?`）会把源的全部音轨静默丢弃，
        // 产物无声（真机复现：双音轨 mkv + 同名 .srt → 产物 0 条音频流）。
        // 与其余三条分支（SUB_ARGS_MKV / SUB_ARGS_MP4 / SUB_ARGS_MP4_DROP）保持一致。
        pushStreamMaps(entry, inputArgs, ["-map", "0:a?", "-map", "1:0?"])
        return
    }

    // 2. 内嵌字幕：MKV 容器无损直通复制
    if (isMkv) {
        pushStreamMaps(entry, inputArgs, SUB_ARGS_MKV)
        return
    }

    // 3. 内嵌字幕：MP4 容器（检测 PGS/VobSub 等图形字幕容错降级）
    const subs = entry.info?.subtitles
    const hasBitmap = Array.isArray(subs) && subs.some(isBitmapSubtitle)
    if (hasBitmap) {
        log.logWarn(
            "FFConv",
            "Bitmap subtitle (PGS/VobSub) is not supported in MP4 container; dropping subtitles with -sn",
        )
        pushStreamMaps(entry, inputArgs, SUB_ARGS_MP4_DROP)
    } else {
        pushStreamMaps(entry, inputArgs, SUB_ARGS_MP4)
    }
}

/**
 * 判断源文件是否为包含过期统计标签 (如 mkvmerge 混流写入的 BPS/NUMBER_OF_BYTES) 的特殊 MKV。
 * 仅对携带此类标签的 Matroska 容器生效，MP4/MOV 及无统计的普通容器直接返回 false。
 * @param {Object} entry - 文件对象
 * @returns {boolean}
 */
export function hasMkvStatistics(entry) {
    if (!entry) return false
    if (entry.hasMkvStats === true) return true
    if (entry.hasMkvStats === false) return false

    const ext = path.extname(entry.path || "").toLowerCase()
    const fmt = String(entry.info?.format || "").toLowerCase()
    const isMkv =
        ext === ".mkv" ||
        ext === ".mka" ||
        ext === ".webm" ||
        fmt.includes("matroska") ||
        fmt.includes("webm")
    if (!isMkv) return false

    const checkTags = (obj) => {
        if (!obj || typeof obj !== "object") return false
        for (const k of Object.keys(obj)) {
            const upper = k.toUpperCase()
            if (
                upper === "_STATISTICS_TAGS" ||
                upper === "_STATISTICS_WRITING_APP" ||
                upper === "BPS" ||
                upper.startsWith("BPS-") ||
                upper === "NUMBER_OF_BYTES" ||
                upper.startsWith("NUMBER_OF_BYTES-") ||
                upper === "NUMBER_OF_FRAMES" ||
                upper.startsWith("NUMBER_OF_FRAMES-")
            ) {
                return true
            }
        }
        return false
    }

    if (
        checkTags(entry.tags) ||
        checkTags(entry.info?.tags) ||
        checkTags(entry.info?.format?.tags) ||
        checkTags(entry.info?.video?.tags) ||
        checkTags(entry.info?.audio?.tags)
    ) {
        return true
    }

    const raw = entry.rawMetadata || entry.info?.raw
    if (raw) {
        const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw)
        if (
            rawStr.includes("_STATISTICS_TAGS") ||
            rawStr.includes("NUMBER_OF_BYTES") ||
            rawStr.includes('"BPS"') ||
            rawStr.includes("BPS-")
        ) {
            return true
        }
    }

    return false
}

/**
 * 构建元数据参数（音频标签/纯净标题/用户自定义元数据）
 * 不再强制覆写 description 和 copyright，避免冲掉原片元数据；
 * 标题去除扩展名后缀（纯净影片名）。
 * @param {Object} entry - 文件对象
 * @param {Object} tempPreset - 预设副本
 * @returns {string[]} 元数据参数数组
 */
export function buildMetaArgs(entry, tempPreset) {
    const metaArgs = []

    // 音频文件才添加元数据
    // 检查源文件元数据
    if (helper.isAudioFile(entry.path) && entry.tags?.title) {
        const KEY_LIST = ["title", "artist", "album", "albumartist", "year"]
        // 验证 非空值，无乱码，值为字符串或数字
        const validTags = core.filterFields(entry.tags, (key, value) => {
            return (
                KEY_LIST.includes(key) &&
                Boolean(value) &&
                ((typeof value === "string" && value.length > 0) || typeof value === "number") &&
                !enc.hasBadCJKChar(value) &&
                !enc.hasBadUnicode(value)
            )
        })
        // 去掉值字符串中的单双引号，避免参数解析错误
        for (const [key, value] of Object.entries(validTags)) {
            if (typeof value === "string") {
                validTags[key] = value.replaceAll(/['"]/gi, " ")
            }
        }
        for (const [key, value] of Object.entries(validTags)) {
            metaArgs.push("-metadata", `${key}=${value}`)
        }
    } else {
        const pureTitle = path.parse(entry.name || "").name || entry.name
        metaArgs.push("-metadata", `title=${pureTitle}`)
    }

    // 仅当源文件为包含过期统计标签 (如 mkvmerge 混流写入的 BPS/NUMBER_OF_BYTES) 的特殊 MKV 时，
    // 才显式清空重编码轨上的过期统计标签，防止 MediaInfo 误读旧码率造成严重显示失真。
    // 普通 MP4 或无统计标签的容器绝不冗余追加这 12 个参数。
    if (hasMkvStatistics(entry)) {
        if (tempPreset.type === "video") {
            metaArgs.push(
                "-metadata:s:v",
                "BPS=",
                "-metadata:s:v",
                "NUMBER_OF_BYTES=",
                "-metadata:s:v",
                "NUMBER_OF_FRAMES=",
                "-metadata:s:v",
                "_STATISTICS_TAGS=",
                "-metadata:s:v",
                "_STATISTICS_WRITING_APP=",
                "-metadata:s:v",
                "_STATISTICS_WRITING_DATE_UTC=",
            )
        }

        // 若音频轨被重编码 (非 copy)，同样清除音频轨上的过期 BPS 统计标签
        const isAudioCopy =
            Boolean(tempPreset.audioCopy) ||
            tempPreset.userArgs?.audioCodec === "copy" ||
            tempPreset.audioCodec === "copy"
        if (!isAudioCopy) {
            metaArgs.push(
                "-metadata:s:a",
                "BPS=",
                "-metadata:s:a",
                "NUMBER_OF_BYTES=",
                "-metadata:s:a",
                "NUMBER_OF_FRAMES=",
                "-metadata:s:a",
                "_STATISTICS_TAGS=",
                "-metadata:s:a",
                "_STATISTICS_WRITING_APP=",
                "-metadata:s:a",
                "_STATISTICS_WRITING_DATE_UTC=",
            )
        }
    }

    // 用户 --metadata 追加（定稿）：排在自动项之后 → ffmpeg「后写覆盖」自动 title/同名字段。
    // 每个 key=value 作为单个 argv token（值内空格得以保留，如 title=My Video）。
    const userMeta = tempPreset.userArgs?.metadataPairs
    if (Array.isArray(userMeta)) {
        for (const [k, v] of userMeta) {
            metaArgs.push(`-metadata`, `${k}=${v}`)
        }
    }
    // 注意：这里直接使用 metaArgs 数组，不能再 join(" ") 后再 split(" ")——
    // 那个往返会把含空格的值（如 title=My Movie）拆成多个 argv。
    return metaArgs
}
