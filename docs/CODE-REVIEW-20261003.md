# FFConv GUI 代码审查报告（架构 / 业务逻辑 / 界面交互）

- 审查日期：2026-10-03 17:48 (GMT+8)
- 审查范围：`src/main`、`src/preload`、`src/shared`、`src/renderer`（30 文件）、`core/transcode`、`core/lib`、`presets/default.yaml`、`electron.vite.config.ts`、`electron-builder.yml`、`tests/**`
- 审查方式：全量逐行阅读 + 关键路径真机复现（ffmpeg / ffprobe 实跑）+ 静态核对
- 结论：**架构分层清晰、安全基线达标、并发/取消/临时文件清理做得比一般项目扎实**；但存在 **4 个 P0**（其中 2 个会造成用户数据损失或功能不可用）、**11 个 P1**、一批 P2/P3。

严重度定义：

| 级别 | 含义 |
|---|---|
| P0 | 必然发生且造成数据损失 / 功能不可用，必须本轮修 |
| P1 | 高频路径上的错误行为或功能缺陷，用户可感知，需尽快修 |
| P2 | 边界/异常路径缺陷、一致性问题、可维护性隐患 |
| P3 | 体验打磨、无障碍、代码整洁度 |

---

## 0. 摘要

| 级别 | 数量 | 代表问题 |
|---|---|---|
| P0 | 4 | 外挂字幕转码**丢掉全部音轨**（已实测复现）；打包后内置预设加载失败导致应用不可用；引擎事件被订阅两次（日志双写 + 通知双弹 + 监听器泄漏） |
| P1 | 11 | `-movflags` 双写导致 faststart 静默失效（已实测）；AAC 预设码率被智能码率覆盖；音频任务拿不到 `caps` → 编码器回退链路失效；拖放遮罩不复位；进度计数 `7 / 2`；窄窗口 0px 列；设置弹窗「取消」不回滚；设置收窄值不回写；任务表 O(N²)；日志时间戳三格式混用；探测命令与执行命令不同构 |
| P2 | 31 | 同名输出静默跳过、源文件可被删除、预设只校验类型不校验值域、ffprobe 无超时、进度可回退、路径去重不折叠大小写、错误分类能力≈0、主题逻辑三处重复、无障碍缺口、文档与预设漂移、任意文件追加原语、userData 路径分裂 等 |
| P3 | 20+ | 死配置、formatSize、FOUC、Toast 计时器、CSP 收紧、侧栏宽度不持久化 等 |

**已核实无问题**（不要误改，见 §5）：沙箱与 CSP 配合、`contextIsolation/nodeIntegration`、`v-html` 当前安全、设置白名单与 `AppSettings` 一一对应、高危开关不持久化、取消与临时文件三层清理、`shell:false` 数组传参无注入、目录扫描不阻塞事件循环、`debug.js` 两条并行路径都落盘、硬件能力探测缓存与超时双保险、`externalizeDepsPlugin` exclude 与 devDependencies 完全一致。

---

## 1. P0 问题

### P0-1 外挂字幕分支丢掉全部音轨（输出 MP4 无音频）—— 已真机复现

**位置**：`core/transcode/ffmpeg_tags.js:140-155`

```js
// 1. 外挂字幕：优先挂载外挂文件并映射
if (entry.selectedSubtitle) {
    const subCodec = isMkv ? "copy" : "mov_text"
    inputArgs.push("-i", entry.selectedSubtitle, "-c:s", subCodec,
                   "-metadata:s:s:0", "language=chi", "-disposition:s:0", "default")
    pushStreamMaps(entry, inputArgs, ["-map", "1:0?"])   // ← 只映射视频 + 字幕，没有 0:a?
    return
}
```

同文件其余三条分支都带 `-map 0:a?`（`SUB_ARGS_MKV` / `SUB_ARGS_MP4` / `SUB_ARGS_MP4_DROP`，`:69-71`），唯独这条没有。而 `:40-42` 的注释已经写明「ffmpeg 只要出现任意 `-map` 就会切到手动流选择」——只给 `-map 0:a?` 而不给视频会自动补视频流，**反向同理：不给 `-map 0:a?` 时音频流被整体丢弃**。

**触发条件是自动的，不需要用户做任何操作**：`core/transcode/ffmpeg_task.js:92-105` 会扫描源文件同目录同 basename 的 `.ass/.ssa/.srt`，存在即自动挂载：

```js
const subExts = [".ass", ".ssa", ".srt"]
for (const ext of subExts) { ... if (await fsApi.pathExists(subPath)) subtitles.push(subPath) }
selectedSubtitle: chooseSubtitle(subtitles),
```

即：**只要视频旁边放一个同名字幕文件，转码产物就没有声音**，且全程无任何 warn。

**复现（已在本机执行，ffmpeg N-126733）**：

```powershell
# 1) 造一个 视频+2音轨+外挂srt 的 mkv
ffmpeg -f lavfi -i testsrc=size=320x240:rate=10:duration=3 -f lavfi -i sine=frequency=440:duration=3 `
       -f lavfi -i sine=frequency=880:duration=3 -map 0:v -map 1:a -map 2:a multi.mkv
ffmpeg -i multi.mkv -f srt -i sub.srt -map 0 -map 1 -c copy -c:s srt withsub.mkv

# 2) 用引擎真实产出的命令跑（由 buildCliTask + createFFmpegArgs 打印，见下）
ffmpeg -hide_banner -v error -n -i withsub.mkv -i withsub.srt -c:s mov_text `
  -metadata:s:s:0 language=chi -disposition:s:0 default -map 0:0 -map 1:0? `
  -c:a aac -b:a 192k -map_metadata 0 -movflags +faststart -movflags use_metadata_tags out.mp4
# EXIT=0

# 3) 检查产物流
ffprobe -v error -show_entries stream=index,codec_type -of csv=p=0 out.mp4
0,video
1,subtitle        # ← 音频流为 0 条
```

引擎侧打印的真实命令（`buildCliTask` + `createFFmpegArgs`，preset=hevc_2k）：

```
-hide_banner -n -v error -progress - -nostats -i withsub.mkv -i withsub.srt -c:s mov_text
-metadata:s:s:0 language=chi -disposition:s:0 default -map 0:0 -map 1:0? -c:a aac -b:a 192k
-metadata title=withsub -map_metadata 0 -movflags +faststart -movflags use_metadata_tags <out>.mp4
```

对照组（仅加 `-map 0:a?`）：`0,video / 1,audio / 2,audio / 3,subtitle`，双音轨完整保留。

**修法**：

```js
// ffmpeg_tags.js:153
pushStreamMaps(entry, inputArgs, ["-map", "0:a?", "-map", "1:0?"])
```

同时补单测：`tests/unit/` 增加一条「外挂字幕 + 双音轨输入 → argv 必须含 `-map 0:a?`」，并在 e2e 用一条带同名 `.srt` 的素材断言产物 `ffprobe` 有音频流。

---

### P0-2 打包后内置预设加载失败 → 应用完全不可用

**位置**：`core/transcode/preset_loader.js:46-49, 245-247` + `electron-builder.yml:7-15`

```js
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_PRESET_DIR = path.join(MODULE_DIR, "..", "..", "presets")   // :47
...
const paths = customPath ? [path.resolve(customPath)]
                         : [DEFAULT_PRESET_PATH, ...USER_SEARCH_PATHS]              // :247
// USER_SEARCH_PATHS = ~/.mediac/presets.yaml|.yml、process.cwd()/presets.yaml|.yml
```

- `core/` 被 rollup 内联进 main bundle（`electron.vite.config.ts:27-46` 只外置 electron/Node 内建），打包后 `import.meta.url` = `…/app.asar/out/main/index.js` → `DEFAULT_PRESET_PATH` = `…/app.asar/presets/default.yaml`。
- `electron-builder.yml` 的 `files` 只有 `out/**/*` + `package.json`，`presets/` 走的是 `extraResources → <resources>/presets`，**不在 asar 内**；`app.asar/presets/` 不存在。
- `src/main/ffmpeg-environment.ts:221` 调的是 `presets.initPresetsAsync()`（不传 customPath），因此 **`<resources>/presets/default.yaml` 从来没被真正读过**；`:155-168` 的 `resolvePresetPath()` 只在报错文案里用到。
- 开发态之所以正常：`out/main` 上溯两级正好是仓库 `presets/`。

失败链条：`getAllNames()` 为空 → `ffmpeg-environment.ts:223-230` 抛「预设解析失败」→ `ffmpeg-service.ts:582-588` `No FFmpeg presets are available` → 预设下拉为空、无法创建计划，**装出来的包完全不可用**。

**修法**（二选一，推荐前者）：

```js
// preset_loader.js：把打包资源目录纳入候选，优先级最低
import { app } from "electron"  // core 不得依赖 electron —— 改为由宿主传入
```

core 不得反向依赖宿主，正确做法是宿主显式传路径：

```ts
// ffmpeg-environment.ts:221 附近
const bundled = path.join(process.resourcesPath, "presets", "default.yaml")
await presets.initPresetsAsync(/* customPaths */ [bundled])   // 或新增 loadPresetLayers 的 extraSearchPaths
```

注意不能用 `customPath` 作唯一来源（会丢掉 `~/.mediac/presets.yaml`、`cwd/presets.yaml` 用户层，这一点 `ffmpeg-environment.ts:217-220` 的注释已经写明）。

**配套**：在 `scripts/` 加一个打包产物自检——解包 `app.asar`，断言 `out/main/index.js`、`out/preload/index.cjs`、`out/renderer/index.html` 存在，且断言 `<resources>/presets/default.yaml` 存在，并把 `DEFAULT_PRESET_PATH` 的解析结果写进启动日志。

---

### P0-3 引擎事件被订阅两次：日志双写、系统通知双弹、首个监听器永久泄漏

**位置**：`src/renderer/src/App.vue:526-528 / 538` 与 `:660-661`

```ts
function subscribeEngineEvents() {
  unsubscribeEvents = window.api.onEngineEvent(handleEngineEvent)   // :527  第 1 次
}
subscribeEngineEvents()                                            // :538  "必须第一个订阅"
...
// Subscribe to engine IPC events
unsubscribeEvents = window.api.onEngineEvent(handleEngineEvent)     // :661  第 2 次（覆盖退订句柄）
```

`preload/index.ts:63-67` 每次 `ipcRenderer.on` 返回独立 unsubscribe，两次订阅 = 两个常驻 listener。后果：

1. 每条 `task.log` 事件被处理两次 → **日志面板每行重复**，主进程 `forwardLogToPanel` 转发过来的引擎日志也翻倍；
2. `session.summary` 处理两次 → `App.vue:147` `window.api.notify(...)` **每批弹两次系统通知**；
3. `onUnmounted`（`:682`）只能摘掉第 2 个，**第 1 个在组件卸载后仍挂在 `ipcRenderer` 上**（销毁后继续写 store）；
4. `planStore.updateTaskProgress` 白跑一次全表拷贝（`plan.ts:353` `[...tasks.value]`），大列表额外翻倍开销。

`:531-537` 那一大段注释（说明必须早订阅）证明第 538 行是有意为之，`:660-661` 是后来追加时漏删。

**修法**：删除 `:660-661` 两行；并在 `onMounted` 末尾加一句断言 `if (unsubscribeEventsAlreadySet) throw` 防止复发。

**e2e 为什么没抓到**：现有 7 个 spec 没有任何一条断言日志行数或通知次数。

---

### P0-4 音频预设码率被「智能码率」覆盖，选 128K 实际出 320K

**位置**：`core/transcode/ffmpeg_plan.js:322-337` + `presets/default.yaml:84-95, 359-383`

```js
if (srcAudioBitrate > 0) {
    if (ep.smartBitrate) {
        dstAudioBitrate = bitrateMap.find((br) => srcAudioBitrate > br.threshold)?.value || 48 * 1000
    } else {
        dstAudioBitrate = reqAudioBitrate          // ← 只有 smartBitrate=false 才用预设/用户值
    }
}
```

`_base_aac_cbr` 声明 `smartBitrate: true`（`:91`），而 `aac_high/medium/low/he`（`:360-377`）只覆盖 `audioBitrate`，**没有覆盖 `smartBitrate`**，全部继承 true。于是对音频输入：

| 预设 | 声明码率 | 320K 源实际产出 |
|---|---|---|
| `aac_high` | 256k | 320K |
| `aac_medium` | 192k | 320K |
| `aac_low` | 128k | **320K** |
| `aac_he` | 96k | **320K** |
| `aac_voice` | 48k | 48K（唯一正确，它显式 `smartBitrate: false`） |

更糟的是 `_base_aac_cbr.suffix = "_{audioBitrateK}"`（`:88`），文件名会把错误的 320K 一起写进去（如 `xxx_320K.m4a`），**进一步掩盖问题**；无损源（FLAC）走 `ffmpeg_plan.js:313-315` 的 `999000` 分支，同样命中最高档。

**修法**：让「用户显式/预设显式给的码率」优先于智能码率：

```js
if (ep.userArgs.audioBitrate || ep.audioBitrate) dstAudioBitrate = reqAudioBitrate
else if (ep.smartBitrate) dstAudioBitrate = bitrateMap.find(...)?.value || 48 * 1000
else dstAudioBitrate = reqAudioBitrate
```

或等价地给 `aac_*` 预设补 `smartBitrate: false`。推荐前者（对用户自定义预设同样生效）。补单测覆盖「预设码率 < 源码率档位」场景。

---

## 2. P1 问题

### P1-1 `-movflags` 双写导致 faststart 静默失效 —— 已实测

`presets/default.yaml:60, 80, 95, 236` 四处：

```yaml
outputArgs: "-movflags +faststart -movflags use_metadata_tags"
```

`core/transcode/ffmpeg_build.js:615-617` 直接 `split(" ")` 展开为 `["-movflags","+faststart","-movflags","use_metadata_tags"]`。`-movflags` 是 mov muxer 的**单值 AVOption**，后者整体覆盖前者。仓库自己的文档 `docs/ffmpeg/ffmpeg-guide-hwaccel-compat.md:509` 已给出正确形态 `-movflags +faststart+use_metadata_tags`。

实测（同一源、`-c copy`）：

| 命令 | 产物大小 | `moov` vs `mdat` | faststart | `mdta` |
|---|---|---|---|---|
| 无 movflags | 320739 | moov@317677 / mdat@44 | ✗ | ✗ |
| `+faststart` | 320739 | moov@36 / mdat@3110 | ✓ | ✗ |
| `use_metadata_tags` | 320930 | moov@317677 / mdat@44 | ✗ | ✓ |
| **两者分写（当前预设）** | 320930 | moov@317677 / mdat@44 | **✗** | ✓ |

即当前所有 mp4/m4a 内置预设（`h264_* / hevc_* / av1_* / aac_*`）的 moov 都落在文件尾，**「秒开」配置形同虚设，且无任何日志提示**。

**修法**：四处改为 `-movflags +faststart+use_metadata_tags`；并在 `buildStreamArgs` 对单值 AVOption 重复出现时 `log.warn`。

### P1-2 音频任务拿不到 `caps` → 编码器静态回退完全失效

`core/transcode/ffmpeg_run.js:702-711`（音频早返回）与 `:729-741`（`--video-copy` 早返回）都没有 `caps` 字段，而视频分支 `:782` 有：

```js
if (helper.isAudioFile(entry.path) || entry.preset?.type === "audio") {
    const cpuTier = TIERS.find((t) => t.name === "cpu")
    return { tier: cpuTier, size: null, degraded: false, tried: ["cpu"], reason: ... }   // ← 无 caps
}
```

`ffmpeg_build.js:316` 的 `buildAudioArgs(entry, tempPreset, hwPlan?.caps)` 因此拿到 `undefined`，`:567-570`：

```js
if (!codecOrArgs || !encoders || encoders.size === 0) return codecOrArgs   // 直接原样返回，不降级
```

`fallbackAudioEncoder`（libfdk_aac → aac）恰恰**只在音频任务上最需要**（libfdk 是 nonfree-only，多数 ffmpeg 构建没有）。一旦用户自定义预设写了 `libfdk_aac`，整批音频任务 `Unknown encoder 'libfdk_aac'` 全灭。文档 `FFMPEG-USAGE.md §9.7` 承诺的「缺失自动降级为 aac」实际不生效。

**修法**：两个早返回分支都带 `caps: await detectHardwareCapabilities({ ffmpegPath: bin || ffmpegPath })`（有 in-flight 去重与缓存，成本可忽略）。

### P1-3 拖放遮罩在 dropzone 释放后不复位 → 全屏遮罩常驻

`GlobalDropMask.vue:30-33` 只在 **window** 的 drop 里复位：

```ts
async function onDrop(e) { e.preventDefault(); dragCounter = 0; isDragging.value = false; ... }
```

而左侧 dropzone 用 `@drop.stop="handleDrop"`（`ConfigPanel.vue:424`）阻止了冒泡 → window 的 `onDrop` 不执行，`isDragging` 保持 true。Chromium 在 drop 后**不保证**派发 `dragleave`，于是 `global-drop-mask`（`position:fixed; inset:0; z-index:9999; background:rgba(16,16,20,.85)`，`GlobalDropMask.vue:84-95`）**常驻覆盖整个窗口**，视觉上像应用卡死（`pointer-events:none` 所以还能点，但用户不会知道）。

**修法**：`window.addEventListener("drop", reset, { capture: true })` + `dragend` 复位，或由 `handleDrop` 主动调用暴露的 `resetDragState()`。另外 `onDragOver`（`:26-28`）无条件 `preventDefault()`，应只在 `e.dataTransfer.types.includes("Files")` 时拦截，否则把任意文本拖放也"接受"了。

**e2e 无任何拖放用例**，这条路径零覆盖。

### P1-4 执行看板进度计数会出现 `7 / 2`

`ExecutionBoard.vue:58-67`：

```ts
const executed = planStore.executedTasks.length     // 分母只算本轮执行的
const denom = executed > 0 ? executed : planStore.tasks.length
// 注释自称"分子口径必须与 overallPercent 一致"
const done = planStore.tasks.filter((t) => t.status === "success" || t.status === "skipped").length  // 分子算了全量
```

先跑 10 个成功 5 个，再改配置只勾选 2 个继续跑 → 显示 **「7 / 2」**，且与按 executed 计算的进度条自相矛盾。

**修法**：`done` 改用 `planStore.executedTasks.filter(...)`。

### P1-5 窄窗口自动折叠被「用户手动切换过」永久关闭 → 侧栏列 0px

`App.vue:39-66`：`sidebarTouchedByUser` 一旦被置 true（按一次 `Ctrl+B`），`applyNarrowAutoCollapse()` 就永久 return。而 `NARROW_AUTO_COLLAPSE_PX = 1080` 的自动折叠正是为了避免 `App.vue:47-56` 注释里描述的「窗口 <1080px 时源文件/目标文件两列被压成 0px 不可见」。用户按过一次 Ctrl+B 后再缩到 960px 就**永久复现 0px 列且无任何提示**。

e2e `05-regressions.spec.ts:63-91` 的窄屏用例只跑默认路径（未先手动切换），覆盖不到。

**修法**：把「用户显式意图」改成方向性记忆（手动展开过则不再自动折叠，手动折叠过仍允许自动展开）；或窗口 <1080 时用 CSS `max-width` 把侧栏压到 320px 而不是 0px。

### P1-6 设置弹窗「取消」不回滚任何开关，已即时落盘

`SettingsModal.vue` 里 `adv.override/anime/strict/deleteSource`、`adv.hwaccel/decodeMode/jobs`、`logLevel` 全部 `v-model` / `@click` 直连 `configStore`（`:183-283, :338`），并被 `config.ts:294-298` 的防抖 watcher 立即写盘；`:355` 的「取消」只是 `emit('close')`。

最典型：误开「转码后删除源文件」→ 点取消 → 开关仍是开，下次扫描仍会弹原生确认框。唯一被正确处理的是外部工具路径（先校验后落盘，`:61-99`）。

**修法**：进入弹窗时对 `adv` / `logLevel` 做浅拷贝快照，取消时还原；或把开关改为草稿态，只在「保存设置」时提交。

### P1-7 主进程收窄后的设置值不回写渲染层：界面显示 99，实际生效 8

`src/renderer/src/stores/config.ts:261-268`：

```ts
return window.api?.saveSettings?.(snapshotForPersist())?.then(
    () => undefined,                       // merged 结果直接丢弃
    (err) => console.error(...),
)
```

主进程是唯一安全门，会 clamp（`settings-store.ts:104` `jobs` → [1,8]、`:89` `dimension` → [0,16384]、`:115` `preset` 截断 4096）。渲染层从不回填 → 用户填 99，界面永远显示 99，磁盘是 8，且每次改动又把 99 写回再被 clamp，**用户无从察觉**。

**修法**：`.then((merged) => { if (merged) applySettings(merged) })`，并用一个 `applyingRemote` 标志抑制回环。

### P1-8 任务表 O(N²) 渲染且无虚拟滚动

`TaskTable.vue:229-238`：

```ts
function execIndex(task) { return planStore.tasks.findIndex((t) => t.id === task.id) }  // O(N)
function canMove(task, delta) { const i = execIndex(task); ... }
```

模板里每行 2 次 `canMove`（`:727`、`:739`）→ 每帧 **2N²** 次比较；`visibleTasks`（`:128-149`）每次 `tasks` 变更全量 filter+sort；`:590` 全量渲染无窗口化，每行最多 9 个内联 SVG 按钮。进度事件 10Hz 触发一次 `tasks` 换引用 → N=1000 时表格基本不可用。需求明确要求评估「>1000 任务」，当前无任何窗口化/分页。

**修法**：① `planStore` 增加 `taskIndexById` computed Map，渲染期 O(1)；② 加虚拟滚动或「可视区 ±20 行」渲染窗口；③ `visibleTasks` 按 `tasks.length + 版本号` 增量。

### P1-9 日志时间戳混用三种格式

- `App.vue:104`：`event.timestamp || new Date().toLocaleTimeString()` → 渲染层自造日志受系统区域影响（中文环境 `下午4:12:33`，英文环境 `4:12:33 PM`）
- `core/transcode/ffmpeg_events.js:28`：`timestamp: now().toISOString()` → 引擎事件是 **UTC ISO**（`2026-10-03T04:12:33.481Z`），与本机时区无关地误导
- `stores/log.ts:41-45`：`nowTs()` → 永远 24 小时制 `04:12:33`

同一条日志里出现三种时间列，排查时无法排序/对齐。

**修法**：`logStore.append` 只接受 `number | Date`，内部统一 `new Date(ts).toLocaleTimeString(undefined, { hour12: false })`；或在 `handleEngineEvent` 里把 ISO 转成本地 HH:mm:ss。

### P1-10 探测命令与执行命令不同构（`buildLayerArgs` 漏传 `bitDepth`）

`core/transcode/hwaccel_args.js:340-350`（探测路径）：

```js
const encArgs = buildEncoderArgs(tier.name, { quality, bitrate, maxBitrate, codecFamily,
                                              pixFmt, forcedEncoder, tier, encoders, anime })
                                              // ← bitDepth 缺失
```

而 `buildEncoderArgs` 内部 `:279-286` 正是靠 `bitDepth` 决定 swdec 层的 `-pix_fmt`；真实命令侧传了（`ffmpeg_build.js:273` `bitDepth: entry.info?.video?.bitDepth`）。

结果：swdec 层 + 10bit 源 + h264 族时，探测命令缺 `-pix_fmt yuv420p` → 探测失败 → 该层被静默跳过，全部落到 d3d/cpu（正是 `:270-274` 注释里量化过的「27.7x vs 10.9x」差距所保护的场景）。且 `probeLayer` 只缓存成功（`hwaccel.js:329-334`），每个 10bit 文件都要重跑一次注定失败的干跑。

**修法**：补 `bitDepth`；并在 `tests/unit/` 加一条「探测参数 ≡ 执行参数」的快照断言。

### P1-11 停止转码在主进程回 `ok:false` 时永久卡在「停止中」

`App.vue:389-406`：

```ts
planStore.status = "STOPPING"                 // 先乐观置位
await window.api.stopExecution()              // 只 catch reject，不看返回值
```

主进程 `ffmpeg-service.ts:1214-1217` 在无任务时是 **resolve** 不是 throw：

```ts
if (!this.abortController) return { ok: false, message: "No running task to stop" }
if (this.status !== "RUNNING") return { ok: false, message: `Nothing to stop (current state: ${this.status})` }
```

两侧状态一旦漂移（丢一次 `session.summary`、`getExecutionStatus` 只在启动同步过一次、停在 `.finally()` 之前的 microtask 窗口），`status` 永久停在 `STOPPING` → `isBusy()` 恒真 → 扫描/开始/移除/重排全部**静默失效**，且再点「停止」仍拿 `ok:false`，**没有自愈路径，只能重启应用**。

**修法**：`const res = await window.api.stopExecution(); if (!res.ok) { 回滚 status 并 toast(res.message) }`；另加兜底对账 `getExecutionStatus()`。

---

## 3. P2 问题

### 架构 / 主进程 / 安全

| # | 问题 | 位置 |
|---|---|---|
| P2-1 | `errorFile` 在 `OPTION_KEYS` 白名单里且 `ffmpeg_error.js:104-133` 直接 `fs.appendFile` → 被攻破的渲染层可让主进程向**任意路径追加内容**（完全绕过路径白名单，白名单只管 open/show-in-folder） | `core/transcode/ffmpeg_options.js:32`、`core/transcode/ffmpeg_error.js:104-133` |
| P2-2 | `deleteSourceConfirmed` / `autoConfirm` 由渲染层可控并透传进 argv（`:38-40`、`:199-205`），执行期 `ffmpeg-service.ts:1140` 读 `argv.deleteSourceConfirmed`。今天没炸只因 `deleteCompletedSources` 恰好还要求 `argv.deleteSourceFiles===true`（会触发原生确认框）——**安全门的判定位由不可信方提供**，日后改一行就是无交互删源 | `core/transcode/ffmpeg_options.js:38-40`、`src/main/ffmpeg-service.ts:613-617,1140` |
| P2-3 | `PathWhitelist` 只做词法 `path.resolve` 比较，不解析符号链接/junction。已授权根（或任一源文件父目录）里放一个 junction 即可让 `SYSTEM_OPEN_PATH` 通过白名单后跟随链接打开真实目标 | `src/main/path-whitelist.ts:20-23,58-65`、`src/main/ffmpeg-service.ts:291-306` |
| P2-4 | `transcodeService` 在模块求值期（`index.ts:6` import 早于 `index.ts:17` 的 `app.name=`）就用 `app.getPath("userData")` 构造 3 个 store，而 `index.ts:34-44` 恰恰写明「延迟构造可避免写到错误目录」。**同一目录下 3 个文件用改名前的名字、1 个用改名后的**，静默分裂 | `src/main/ffmpeg-service.ts:225-231,1240` |
| P2-5 | `whenReady` 链上任何异常都只是 `.catch` 写日志 → **进程活着但没有窗口也没有任何提示**，用户只能靠任务管理器杀 | `src/main/index.ts:593-614` |
| P2-6 | 单实例锁失败后只 `app.quit()` 不 return，后续仍设 `app.name`、注册 22 个 IPC handler、构造 3 个 store | `src/main/index.ts:12-15` |
| P2-7 | `dispose()` 里 `void manifest.clearTaskManifest()` 只删清单不清理其记录的 temp 文件；若退出途中被强杀 → 下次启动 `recoverStaleTasks()` 读不到清单 → 半截 `*_tmp@*@tmp_.*` 永久残留在用户输出目录 | `src/main/ffmpeg-service.ts:1226-1236` |
| P2-8 | 渲染层多处 `void window.api.x()` 无 `.catch` → 未处理 rejection（`showInFolder` 路径不在白名单时主进程会 reject） | `TaskTable.vue:36,41,213,286`、`useTaskSelection.ts:75-77` |
| P2-9 | `IpcChannel` 类型导出后**全仓无人使用**，`handleTrusted(channel: string, ...)` 是裸 string，preload 侧返回 `any` → `DesktopApi` 的返回类型全是「愿望类型」 | `src/shared/ipc-channels.ts:52`、`src/main/index.ts:172` |
| P2-10 | 依赖边界（main 只走 facade / preload 不 import core / core 不 import src）100% 靠人工 review，`eslint.config.js` 无 `no-restricted-imports`，tsconfig 把三层编到同一 project | `tsconfig.node.json:14-22`、`eslint.config.js` |
| P2-11 | 事件 → 队列回写是 O(n) 查找 + 全量深拷贝广播：1000 文件 × 4 个状态事件 = 4000 次 O(n) 查找 + 4000 次 1000 项拷贝 + 4000 次 IPC | `src/main/ffmpeg-service.ts:1055-1065`、`src/main/queue-store.ts:235` |
| P2-12 | `SYSTEM_NOTIFY` 的 title/body 无长度上限；`SYSTEM_SAVE_LOG` 有 20MB 上限但无频率限制 | `src/main/index.ts:549-568` |

### 转码引擎

| # | 问题 | 位置 |
|---|---|---|
| P2-13 | **输出同名无自动加序号**：`outputMode:"file"` 扁平化时两个不同源目录的同名文件得到同一 `fileDst`，先到者成功，后到者 `commitOutputFile` 静默 `fs.remove(temp)` 返回 false（`ffmpeg_run.js:121-124`），调用方只 `markDestinationExists` 无日志（`:447-451`）。选 10 个文件得 8 个产物 | `core/transcode/ffmpeg_task.js:253`、`core/transcode/ffmpeg_run.js:116-137` |
| P2-14 | **源=目标 + `--override` 会永久删除源文件**：`prefix/suffix` 都为空且预设 format 与源扩展名相同时 `fileDst === entry.path`，`:253` 的守卫因 `(prefix||suffix)` 为假而整条跳过；`commitOutputFile` 的 override 分支把源文件 move 成 `xxx.old@<ts>` 备份 → 移入新文件 → **立刻 `fs.remove(backup)`**（`:126-137`） | 同上 |
| P2-15 | `preset_schema.js` 只校验类型不校验值域：`dimension:-100` → `calculateDstArgs` 的 `dstScaleNeeded=false`，但 `ffmpeg_run.js:748` 的 `entry.dstArgs?.dimension \|\| ...` 取到 -100（真值）→ `calcLongEdge` 抛错 → **整批每个文件都失败**，且错误文案指向「分层计划」而非「预设写错」，排查方向被带偏。`videoQuality:-5` 被夹到 0（近无损，体积暴涨） | `core/transcode/preset_schema.js:146-155`、`core/transcode/ffmpeg_run.js:748` |
| P2-16 | execa 未设 `maxBuffer`（默认 100MB），`--debug`（`-v repeat+level+info`）下长片源 stderr 溢出 → `MaxBufferError` → **转码其实已完成却被判失败**，随后还会触发一次无意义的 CPU 重试 | `core/transcode/ffmpeg_run.js:600-609` |
| P2-17 | `ffprobe` / `mediainfo` 调用**无超时**（对比 `hwdetect.js:287-296` 的 `settleWithin`），网络盘或被杀软挂起的 probe 会让 `createPlan` 永久停在 `PLANNING`，`isExecuting()` 恒真，reload 被永久禁止 | `core/lib/mediainfo.js:58-61,85-88` |
| P2-18 | 进度可回退：`updateTaskProgress` 无 `Math.max`（只防了 status 乱序），且**自动重试（`maxAttempts:2` + `confirmRetry: () => true`）会重建 task** → 60% 失败后第二轮从 0% 上报，进度条跳回 0。`TaskStatus` 里的 `retrying` 有 UI 映射（`TaskTable.vue:84`）和筛选器（`:109`）但**全仓无任何生产者**，`TASK_ATTEMPT_STARTED` 事件引擎已发、渲染层未处理 | `src/renderer/src/stores/plan.ts:350-366`、`src/main/ffmpeg-service.ts:1078-1086` |
| P2-19 | 进度解析无跨 chunk 残留缓冲：`data.toString().split("\n")`，`out_time` 被切断时先解析出中间值 → 抖动/回退 | `core/transcode/ffmpeg_progress.js:68-71` |
| P2-20 | 错误分类能力≈0：`core/lib/error-codes.js` 定义了 `INSUFFICIENT_DISK_SPACE` 等码但**整条转码链路从未引用**；`ffmpeg_error.js:63-64` 的正则不含 `unknown`，最常见的 `Unknown encoder 'libsvtav1'` 全部落到「最后一行」兜底，多半返回 `Conversion failed!` 这种无信息量文案；磁盘满/无权限没有专门提示 | `core/transcode/ffmpeg_error.js:11-19,53-70`、`core/lib/error-codes.js` |
| P2-21 | 「产物异常小」判据只覆盖极端值：1GB 源编出 500KB（滤镜链半失效/硬编静默丢帧）判成功并提交，用户拿到明显劣化文件 | `core/transcode/ffmpeg_run.js:434-436` |
| P2-22 | TOCTOU 防护是死代码：`isPlanCurrent` / `assertPlanCurrent` / `STALE_PLAN` 只有定义处 3 处引用，`index.js` 未导出，宿主从未调用。计划后源文件被替换仍按计划期 `info` 算 scale/码率 | `core/transcode/ffmpeg_planner.js:193-205`、`core/transcode/index.js:14` |
| P2-23 | 非基准任务的「预计命令」是渲染层字符串替换伪造的（`replaceAll(baseTask.path, task.path)`），同批任务源分辨率不同时展示的是**错的 scale 尺寸 / `-pix_fmt` / `-maxrate`** | `src/renderer/src/stores/plan.ts:397-416` |
| P2-24 | `--speed` 对音频类预设静默忽略：`-af atempo` 只在 `buildFilterArgs` 产出，而它仅对视频预设调用。`audio_extract` + `--speed 1.5` 会**放弃 copy 强制重编码，却不施加变速**——付出代价得到原速音频 | `core/transcode/ffmpeg_build.js:313-319,419-425` |
| P2-25 | `i18n.js:1185-1188` 用 `String.replace(regex, value)` 做模板替换，值里的 `$&`/`$1` 会被特殊解释。当前只传简单值未触发，但把用户输入回显的 key 一旦出现即中招 | `core/lib/i18n.js:1185-1188` |
| P2-26 | `parseFilelist` 逐行串行 `await fs.stat`，10k 行 = 10k 次串行 await；`asyncFilter`（rename.js:256-270）串行 reduce+await | `core/lib/file.js:136-175`、`core/lib/rename.js:256-270` |
| P2-27 | `auto` 全降级链（最多 5 层 × 15s 超时）+ 并发 8 时，最坏可同时存在 8 个串行干跑，单任务长时间占位 | `core/transcode/hwaccel.js:453-519` |

### 界面 / 交互

| # | 问题 | 位置 |
|---|---|---|
| P2-28 | `removeTask` 后 tasks 清空但 `planSnapshot` 未清 → `startExecution` 的四个重规划条件都不满足 → 「开始转码」**静默空转**（`App.vue:356` 直接 return），用户按了没反应也没提示 | `stores/plan.ts:141-165`、`App.vue:284-356` |
| P2-29 | 路径去重不归一：`config.ts:172` 是裸字符串 Set，主进程用 `path.resolve`（归一分隔符但**不折叠大小写**）→ 分隔符差异导致左侧留幽灵 chip 且与表格行数不一致；大小写差异导致同一文件被转码两次 | `stores/config.ts:171-174`、`src/main/ffmpeg-service.ts:411` |
| P2-30 | 「与源文件同级」取消勾选但 `savedCustomOutputDir` 为空时 `outputDir` 前后都是 `""` → watcher 不触发 → **不标 STALE**，且 `outputBesideSource` 根本没进 payload → UI 说「输出到自定义目录」实际按同级执行 | `stores/config.ts:28-47`、`ConfigPanel.vue:62-76`、`App.vue:200` |
| P2-31 | 导入暂存失败只写日志抽屉不弹 Toast（扫描失败有 Toast）→ 200 个文件里少一部分，首屏完全无感知 | `composables/useInputIngest.ts:59-66` vs `App.vue:259-260` |
| P2-32 | 多个按钮的 `:disabled` 判据与 `App.vue` 里的 `isBusy()` 守卫不一致，导致「可点但静默无效」：顶栏「清空」只挡 RUNNING（PLANNING/STOPPING 时可点但 `clearAll` 早退）、顶栏「扫描」（`:125`）只挡 RUNNING/PLANNING（STOPPING 时可点但 `createPlanInternal` 早退）、行内 ✕ 完全没有 `:disabled`。同屏的「删除所选」反而正确用了 `:disabled="... \|\| isPlanBusy()"`（`TaskTable.vue:820`） | `TaskTable.vue:205-208,747-757`、`HeaderBar.vue:125,176` |
| P2-33 | `excludedPaths`（移除任务的副作用）会把路径永久排除出后续扫描，UI 上无任何「已排除 N 个文件」提示与恢复入口 | `stores/plan.ts:141-191` |
| P2-34 | 上下文菜单高度硬编码估算 340px（`TaskTable.vue:310`），实测菜单 ≈399px；窗口 `minHeight:640` 时底部「清空列表」在屏幕外且菜单无 `max-height/overflow`，**用户滚不到** | `TaskTable.vue:309-322`、`TaskContextMenu.vue:163-320` |
| P2-35 | 状态文案表三处重复且已漂移（`TaskTable.vue:79-89` / `TaskInspectorDrawer.vue:18-28` / `HeaderBar.vue:26-36`）：`preparing` / `retrying` 在抽屉里缺失；`TaskStatus` 共 9 态，新增状态漏改就显示裸英文枚举 | 三处 |
| P2-36 | `StatusBar.vue:29-40` 只特判 RUNNING/PLANNING，`FAILED`/`STOPPED`/`STALE` 全落到「就绪 · N 个任务」→ 一批失败后**同屏顶栏红字、底栏"就绪"** | `StatusBar.vue:29-40` vs `HeaderBar.vue:38-48` |
| P2-37 | 主题切换逻辑在三处各写一遍（`App.vue:646-651`、`HeaderBar.vue:84-89`、`SettingsModal.vue:38-42`），外加 `SettingsModal.currentTheme` 这第四份状态 | 三处 |
| P2-38 | `v-model.number` 空串不归一：`ConfigPanel.vue:603` 的 `tune.dimension` 可为 `""` → `isDimensionDirty` 认为脏 → 凭空多一个脏点；`SettingsModal.vue:208` 的 `adv.jobs` 同理。`quality` 已有 `normalizeQuality`（`:251-258`），**同一个坑留了 4 个分身** | `ConfigPanel.vue:602-608`、`SettingsModal.vue:207-214` |
| P2-39 | `TaskInspectorDrawer` 在转码期间每 100ms 对整份 ffprobe 元数据 `JSON.stringify`（`:155`）+ 正则重扫命令串（`:148-150`）——10 次/秒 × 几十 KB；且抽屉用 `v-show="showRawMeta"` 根本不一定展示它 | `TaskInspectorDrawer.vue:12,148-177,358` |
| P2-40 | 两个抽屉（LogDrawer / TaskInspectorDrawer）都没有 `role="dialog"` / `aria-modal` / 焦点陷阱 / 焦点归位，`useFocusTrap` 只用在 SettingsModal 与 AboutModal → 键盘用户打开日志抽屉后 Tab 会跑到被遮住的背景表格里 | `LogDrawer.vue:132-140`、`TaskInspectorDrawer.vue:277-283` vs `SettingsModal.vue:135-143` |
| P2-41 | `TaskInspectorDrawer` 的「预览命令」靠**预设名字符串猜编码器**（`presetLower.includes("hevc")` 等）+ 硬编码 CRF 28，猜不出的预设落到默认 libx264 + CRF 23，**显示一条看似合理的错误命令** | `TaskInspectorDrawer.vue:99-146` |
| P2-42 | `TaskContextMenu` 禁用项仍可 Tab 聚焦、仍会被键盘激活：`handleMenuKeydown` 直接 `target.click()`（`:50`），**不受 `pointer-events:none` 影响**。今天没出事靠下游 `paths.length===0` 早退兜着——巧合式安全 | `TaskContextMenu.vue:45-51,258-271,343-347` |
| P2-43 | 渲染层零 i18n（`grep i18n src/renderer` 只命中 `index.html`），而引擎日志是自动检测系统的中/英双语 → 英文系统上「UI 全中文 + 日志面板英文」同屏混排 | `src/renderer/**`、`core/lib/i18n.js:1128-1160` |
| P2-44 | `docs/ffmpeg/FFMPEG-USAGE.md` 与 `presets/default.yaml` 大面积漂移：§4 列的 `h264_4ku/hevc_2ku/av1_4k...` **全部不存在**；`h264_2k` 文档写质量 24 实际 23；§5.2 `-rc-lookahead 20` 实际 30；§9.7 称内置预设用 libfdk_aac（实际是 `aac`）；§9.15 称字幕用 `-map 0:v -map 0:a -map 1`（实际无 `-map 0:a?`，即 P0-1） | `docs/ffmpeg/FFMPEG-USAGE.md` vs `presets/default.yaml` |

### 无障碍（合并计 P2）

- 侧栏手风琴标题是裸 `<div @click>`（`ConfigPanel.vue:556`、`:743`）→ **「视频」「音频」两张卡（几乎所有调参入口）键盘完全打不开**；同文件 `.dropzone`（`:417-426`）有 `tabindex/role` 却是 `role="button"` **无 `@keydown.enter/space`** → 承诺可激活但按 Enter 无反应。
- `.reset-link` 用 `<a>` 但**没有 `href`**（`:407,564,751`）→ 不可聚焦、语义失效。
- `role="checkbox"` 只响应 Space 不响应 Enter（`TaskTable.vue:566,614`），而 `SettingsModal.vue:228-229` 是 space+enter → 同库两种写法。
- 表头 checkbox 无 `indeterminate` 语义（`stores/plan.ts:101` 只有布尔二值），1000 选 1 与全不选读屏无法区分；`.ck` 无 `:focus-visible` 样式。
- 两个进度条无 `role="progressbar"` / `aria-valuenow`（`ExecutionBoard.vue:127-133`、`TaskTable.vue:649-651`）→ 读屏用户在转码期间**完全听不到进度**。
- 任务表 `<tr>` 无 `tabindex`（`:591-602`）→ 键盘用户永远打不开上下文菜单（`handleContextMenuKey` 作用于 `activeTaskId`，而它只能由鼠标设置）。
- Toast 缺 `aria-live` 容器（`ToastHost.vue:8-12`），注释里明确写了要加但没加。

### 打包 / 工程化

| # | 问题 | 位置 |
|---|---|---|
| P2-45 | `asarUnpack: resources/**` 是死配置——`files` 里根本没有 `resources/**`（走 extraResources，天然在 asar 外） | `electron-builder.yml:23-24` |
| P2-46 | `electron.vite.config.ts:11-21` 拷贝的 `out/presets/` 无人读取（唯一读它的 `resolvePresetPath()` 只用于报错文案） | `electron.vite.config.ts:11-21` |
| P2-47 | `externalizeDepsPlugin` exclude 是手工维护的重复声明（15 项）。本次逐项核对与 `core/**` 实际引用**完全一致**，但新增依赖漏加只会得到运行期 `Cannot find module` | `electron.vite.config.ts:29-45` |

---

## 4. P3 打磨项（简要）

1. `formatSize`：`<1000` 字节显示 `0 KB`（`Math.round(0.4)=0`）；用 `1e3/1e6/1e9` 却标 KB/MB/GB；无 TB 分支；无千分位（`utils/format.ts:1-6`）。
2. 深色主题首启 FOUC：`index.html:2` 硬编码 `data-theme="light"`，`App.vue:541-542` 在 `onMounted` 才恢复（首帧已渲染）→ 恢复逻辑内联到 `<head>`。
3. `LogDrawer` 拖拽中按 ESC 关闭 → 组件卸载但 3 个 window 监听泄漏（`LogDrawer.vue:36-38` 无 `onUnmounted` → 调 `stop()`）；侧栏宽度完全不持久化（`App.vue:34`），与两个抽屉的行为不一致。
4. `useToast` 的 `setTimeout` 无句柄、同 id 重复 push 不清理（`composables/useToast.ts:30-37`）。
5. `formatDuration` 对「未探测到时长」返回 `00:00`，与「真的是 0 秒」不可区分（`utils/format.ts:8-15`）。
6. CSP 可收紧：缺 `base-uri 'none'; object-src 'none'; form-action 'none'`；`connect-src` 的 `ws:` 生产包多余（`index.html:6-9`）。
7. `escapeHtml` 只转义 `&<>`，函数名 `escapeHtml` 会误导调用方用于属性场景（当前唯一 `v-html` 点安全，但脆弱）。
8. `setTaskbarProgressError` 用 `{mode:"error"}`，成功路径不传 options → 错误态不会复位（`src/main/native.ts:76-80`）。
9. `flushPersist()` 在 `beforeunload` 里 fire-and-forget，IPC 在卸载期不保证送达 → 防抖窗口内最后一次改动可能丢（`stores/config.ts:285-292`）。
10. `stageInputs` 并发调用会取到同一个 `baseIndex`（`ffmpeg-service.ts:441-443`）→ 序号重复。
11. `createPlanInternal` 有一段完全重复的死代码守卫（`App.vue:176-187`，第二次判断永不可达，却给人"第二道防线"的错觉）。
12. `AboutModal.vue:111` 把 `cpu` 显示成「CPU 硬件加速能力」。
13. `probeError` 通道被用来显示中性说明「音频任务不涉及视频分层」，且用红色 error 样式（`TaskInspectorDrawer.vue:76,395`）。
14. 任务栏/状态栏状态变化没有 `aria-live` 区域（加时需节流，否则转码期刷屏）。
15. `.github-disabled` 目录名暗示 CI 曾被禁用；e2e 需要素材（`data/videos/*.mp4`）不入库，新环境无法跑——建议在 README 写清获取方式或提供生成脚本。
16. `src/main/index.ts:83-91` 的图标候选里 `__dirname/../../resources/icon.ico` 等在打包后是死代码。
17. `stopExecution` 的 `.finally()` 兜底在引擎没发 `onSummary` 时会把「已取消」标成 `COMPLETED`（`ffmpeg-service.ts:1199-1201`）→ 建议显式区分 `controller.signal.aborted`。
18. `LogDrawer` 开启时每条新日志触发一次强制 layout（`scrollHeight/scrollTop/clientHeight` 三读一写）→ 合并到 `requestAnimationFrame`。
19. 死代码/未使用的 composable 出口：`useTaskSelection` 的 `selectAll/clearSelection/invertSelection` 被导出但 `TaskTable` 全部直接用 `planStore.toggleAll`；`stores/log.ts:71-79` 的 `viewTaskLog` 与 `focusTask` 完全同构。
20. `escapeHtml`/Toast/抽屉宽度等多处 P3 已在 §3 无障碍合并项中列出，此处不重复。

---

## 5. 已核实无问题（请勿误改）

| 项 | 核实方式 |
|---|---|
| `-movflags` 与 dry-run 的 `-f null -` 共存 | 实跑 `ffmpeg ... -movflags +faststart -movflags use_metadata_tags -frames:v 10 -f null -` → **EXIT=0**，不构成问题（此前怀疑已排除） |
| 外壳安全：`contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`；`setWindowOpenHandler(deny)`；`will-navigate` preventDefault；`setPermissionRequestHandler` 与 `setPermissionCheckHandler` **都**返回 false | 逐行读 `src/main/index.ts:366-371,393-411,603-609` |
| 无 `shell.openExternal` 调用（全仓 grep），不存在「打开外部 URL 未校验协议」 | grep |
| preload API 面是固定方法，未暴露 `ipcRenderer` 本身或任意 `invoke(channel,…)`；`safeClone` 走 JSON 往返 | 读 `src/preload/index.ts:5-107` |
| 路径白名单**不能被 `../` 绕过**（先 `path.resolve` 词法归一再比较）；junction 绕过见 P2-3 | 读 `path-whitelist.ts:20-23`、`ffmpeg-service.ts:291-293` |
| 唯一 `v-html` 点当前安全：所有插值经 `escapeHtml`，且 CSP `script-src 'self'` 无 `unsafe-inline` | 读 `TaskInspectorDrawer.vue:396`、`utils/format.ts:17-57` |
| 「转码后删除源文件」确认门当前闭合：未注入 `confirmDeleteSource` 时默认 `async () => false`（fail-closed），且渲染层伪造 `deleteSourceConfirmed` 也无法触发删除 | 读 `ffmpeg-service.ts:192-193,604-617,1140`、`index.ts:439-457` |
| `sanitizeSettings` 白名单与 `AppSettings` **严格一一对应**（无遗漏、无多余），数值有区间收窄，注入走 `JSON.stringify` + 原子写；高危开关 `deleteSource` 不在 `PersistedAdv` 中，**不可能跨会话继承** | 逐字段核对 `contracts.ts:248-289` ↔ `settings-store.ts:88-126`；`tests/unit/settings-store.test.js:19-34` 有断言 |
| 并发/队列状态机：`startExecution` 在任何 await 之前占位（防双击双起引擎）；`createPlan`/`probeTask` 挡住三种忙态；`reorderQueue` 要求排列一致否则整单拒绝；`markRunningInterrupted` 不会自动重跑 | 读 `ffmpeg-service.ts:867-875,566-574,759-761,249-251,383` |
| 取消与临时文件三层清理：`finally` 删 temp + 在途登记 + `exit` 钩子（Electron 下正确跳过信号处理器）+ `FfmpegManifest.recoverStaleTasks()` 启动兜底（三重结构校验，宁残留不误删） | 读 `ffmpeg_run.js:67-103,140-159,519-524`、`ffmpeg-manifest.ts:24-57` |
| 无 shell 注入面：`execa(bin, args[], {shell:false})` 数组直传，含空格/中文/引号的 Windows 路径天然安全；`prefix/suffix` 经 `filenameSafe` 过滤 Windows 保留名与非法字符 | 读 `ffmpeg_run.js:600-609`、`helper.js:596-603` |
| 选项顺序合法：输入侧（`-hwaccel`/`-hwaccel_output_format`）全在 `-i` 之前，编码/滤镜全在之后；未使用 `filter_complex`（变速走 `-vf setpts` + `-af atempo` 由 muxer 按 PTS 保同步） | 读 `ffmpeg_build.js:313-372` |
| 多视频流/封面：`videoStreamMapArgs` 用绝对序号，取不到序号时**整组 `-map` 都不输出**（规避「手动选择会补回封面」的真实坑） | 读 `ffmpeg_tags.js:36-51,84-91` |
| 目录扫描不阻塞事件循环（`fdir` crawl + `pMap` 异步 mapper）；并发探测是有限并发（扫描 4、编码 ≤8），无无限并发 | 读 `ffmpeg_scan.js:33-60`、`ffmpeg_planner.js:54-67` |
| `core/lib/debug.js` 两条并行路径**都**落盘**都**进 sink；`activeLevel` 同时驱动 loglevel 与 `shouldLog`；被过滤的级别不产生落盘 | 读 `debug.js:112-128,217-220,529-534,297-409` |
| 未发现把密钥/token 写入日志（绝对路径与完整命令行落盘是可追溯的有意设计） | grep |
| 硬件能力探测有缓存 + in-flight 去重；`setFFmpegPath` 同时清两份缓存；探测超时双保险（`settleWithin` + `probeDeviceUsable`） | 读 `hwdetect.js:32-35,242-259`、`hwaccel.js:190-210`、`ffmpeg_run.js:51-56` |
| `probeLayer` 只缓存成功、不缓存失败——**这是正确的**（防「一个坏文件把同键正常文件全部降级」），注释记录了真实事故 | 读 `hwaccel.js:329-334` |
| `externalizeDepsPlugin` exclude 15 项与 `core/**` 实际静态/动态 import **完全一致**（13 静态 + 2 动态），无冗余无遗漏 | 逐项核对 `electron.vite.config.ts:29-45` vs `core/**` |
| IPC 通道注册完整：24 个 channel 全部有 handler 或对应单向 `send`，无未注册、无通配、无死通道 | 读 `ipc-channels.ts:25-50`、`main/index.ts:459-591` |
| 依赖方向正确：`src/` 只经 `core/transcode/index.js` facade 调用（2 处 import），无深导入；renderer/preload 无 `node:`/`core` import；`core/` 未反向 import `src/` | 全仓 grep |
| ffmpeg 路径探测边界：缓存失效会重解析（不拿 ENOENT 去跑）；用户填错路径报错而非静默忽略；优先级与文档一致 | 读 `ffmpeg-environment.ts:107-184,304-329` |
| `shell.openPath` 不阻塞事件循环（异步 `stat` + 注释说明为何不用 `statSync`） | 读 `native.ts:17-28` |
| `ipc-serializer` 的循环引用处理正确：`seen` 是递归路径栈（进出成对），DAG 共享子对象不会被误判 `[Circular]` | 读 `ipc-serializer.ts:35-86` |
| `ipc-serializer` / `queue-store` / `core.js` 细节正确：路径白名单抗 `../`；`uniqueByFields`/`countOccurrences` 用 `Object.create(null)` 防 `__proto__` 误判 | 读 `core.js:217,450` |
| `PlanTask` 集合整体替换式更新，无 Vue `ref` + `Set.add()` 漏触发问题 | 读 `stores/plan.ts` 全部 mutator |
| `inspectedTask` computed 不缓存到过期，卸载/删除任务后自动回退 | 读 `stores/plan.ts:34-43` |
| 模态 ESC / 点击遮罩关闭 / 焦点陷阱：`useFocusTrap` 在打开时聚焦、Tab 循环、关闭时归还焦点（`offsetParent !== null` 判可见性），`SettingsModal` 的 `@click.self` 阻止误关 | 读 `useFocusTrap.ts:60-75`、`SettingsModal.vue:134` |
| 页面滚动层次设计合理（`overflow:hidden` + 内部滚动区），无整页滚动冲突 | 读 `theme.css:96-98`、`App.vue:778-786` |

---

## 6. e2e / 单测缺口（现有测试完全覆盖不到上述 P0/P1）

| 缺失场景 | 会漏掉的缺陷 |
|---|---|
| 断言日志行数、系统通知次数 | P0-3（双订阅） |
| 停止后等 3s 断言状态离开 `STOPPING` | P1-11 |
| 目录内 drop → 断言 `global-drop-mask` 不存在 | P1-3 |
| 带同名 `.srt` 的素材 → 转码后 `ffprobe` 断言有音频流 | **P0-1** |
| 部分执行 + 二次执行 → 断言计数不为 `N / M`(N>M) | P1-4 |
| 窄窗口**先**按 Ctrl+B **再**缩窄 → 断言两列宽度 >10px | P1-5 |
| 设置弹窗改开关 → 点取消 → 重开断言已还原 | P1-6 |
| 设置填 `jobs=99` → 保存 → 断言界面显示 8 | P1-7 |
| 导入 >200 文件 → 断言首屏渲染可交互 | P1-8 |
| 日志面板断言时间列格式统一 | P1-9 |
| 音频素材 + `aac_low` → 断言 `-b:a 128k` | **P0-4** |
| mp4 预设产物 box 顺序断言（moov 在 mdat 前） | P1-1 |
| 单测：`buildCliTask` + `createFFmpegArgs` 断言外挂字幕时 argv 含 `-map 0:a?` | **P0-1** |
| 单测：preset 值域校验（`dimension:-100` 应在加载期被拒） | P2-15 |

---

## 7. 建议修复顺序

**第一轮（本迭代，建议全部做完）**

1. P0-1 外挂字幕丢音轨 —— 1 行修复 + 单测（最高性价比）
2. P0-4 音频预设码率被覆盖 —— 判据调整 + 单测
3. P0-3 事件重复订阅 —— 删 2 行 + e2e 断言
4. P1-1 `-movflags` 双写 —— 4 行 YAML
5. P1-11 stopExecution 卡死 —— 加 `ok` 分支
6. P0-2 打包预设路径 —— 宿主传 `resourcesPath` + 打包自检脚本

**第二轮（功能正确性与体验）**

7. P1-3 拖放遮罩复位、P1-4 `7/2`、P1-5 窄窗口、P1-6 取消回滚、P1-7 设置回写
8. P2-28 静默空转、P2-32 按钮可点无效、P2-36 状态栏语义、P2-35 文案表合并
9. P2-13/14 同名冲突与源文件删除（先加「源=目标直接拒绝」+「同名加序号」）
10. P2-18 进度单调钳制 + 接上 `retrying` 状态与 `TASK_ATTEMPT_STARTED`

**第三轮（架构与规模化）**

11. P1-8 虚拟滚动 + `taskIndexById`
12. P2-10 eslint `no-restricted-imports` 门禁、P2-9 `IpcChannel` 真正用起来、P2-47 exclude 列表自动化断言
13. P2-1/2/3 安全面收口（剥离 `errorFile`/`deleteSourceConfirmed`、realpath 比较）
14. P2-16/17 maxBuffer 与 probe 超时、P2-20 错误分类
15. 无障碍合并项（对话框语义、键盘可达、ARIA、indeterminate、focus-visible）
16. P2-43 渲染层 i18n + P2-44 文档与预设重新对齐

---

## 8. 复现本文档结论的命令

```powershell
# P0-1 外挂字幕丢音轨（详见 §1）
ffmpeg -f lavfi -i testsrc=size=320x240:rate=10:duration=3 -f lavfi -i sine=frequency=440:duration=3 `
       -f lavfi -i sine=frequency=880:duration=3 -map 0:v -map 1:a -map 2:a multi.mkv
# 用引擎真实命令打印 argv（需要 preset 已加载）
node --input-type=module -e "import {presets,buildCliTask,createFFmpegArgs,collectInputFiles} from './core/transcode/index.js';
  await presets.initPresetsAsync();
  const e = await collectInputFiles([process.env.MVTEST]);
  const t = await buildCliTask({...e[0], preset: presets.getPreset('hevc_2k'), argv: {}, output: null});
  console.log(createFFmpegArgs(t).args.flat(Infinity).join(' '));"

# P1-1 faststart 失效
ffmpeg -y -i in.mp4 -t 1 -c copy -movflags +faststart -movflags use_metadata_tags out.mp4
python -c "d=open('out.mp4','rb').read(); print(d.find(b'moov'), d.find(b'mdat'))"   # moov > mdat → faststart 丢失

# dry-run 与 -movflags 共存（已排除怀疑）
ffmpeg -hide_banner -v error -n -i in.mp4 -c:v libx264 -crf 23 -movflags +faststart -movflags use_metadata_tags -frames:v 10 -f null -
echo $LASTEXITCODE   # 0
```

---

*本文档为只读审查产物，未修改任何源码。所有"已实测"结论均附可复现命令；标注「需真机核验」的条目请按 AGENTS.md 的 FFmpeg 参数核验纪律执行后再改。*
