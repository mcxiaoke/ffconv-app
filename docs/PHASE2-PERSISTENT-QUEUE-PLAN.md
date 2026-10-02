# 阶段二方案 · 持久化队列与项级预设覆盖

> 状态：**待评审，尚未动代码**
> 上游：[UI-UX-REVIEW.md](./UI-UX-REVIEW.md) 第 4 节「阶段二」、[UI-UX-PHASE1-REPORT.md](./UI-UX-PHASE1-REPORT.md) 第 4 节遗留项
> 本文所有「事实」条目都带文件与代码依据；「推断/建议」会显式标注。

---

## 0. 目标与非目标

**目标**

| | |
|---|---|
| G1 | 关窗 / 崩溃后队列不丢，重启可继续处理 |
| G2 | 队列可排序、可删除、可清空 |
| G3 | 每个条目可各自覆盖**预设与编码调参**，混合批次一次跑完 |

**非目标（本阶段明确不做）**

- 项级**输出位置 / 命名**：一个队列只保留一种输出策略（见 D2）
- 项级**机器能力**（jobs / hwaccel / decodeMode / strict / override）：属宿主环境，保持全局
- **自动续跑**、单文件断点续传（重跑整个文件，不做 ffmpeg 级续传）
- 观看目录 / 服务化（Tdarr 那类能力）
- 输出体积预估（独立项，见阶段一计划遗留）
- **拖拽排序**：改用上/下移按钮（已定，见 §10-2）
- **任务表虚拟滚动**：队列规模暂不作为目标，风险登记在 §8 已知取舍

---

## 1. 现状事实核对

先确认「今天是什么样」，否则方案会建立在想象上。

| # | 事实 | 依据 |
|---|---|---|
| F1 | **输入与队列只活在内存**：主进程用 `stagedEntries: Map` 持有暂存输入，进程结束即空 | [ffmpeg-service.ts](../src/main/ffmpeg-service.ts) `private stagedEntries = new Map<...>()`、`clearStagedInputs()` 只 `clear()` 内存 |
| F2 | 渲染层的输入清单同样不持久化：`inputs` **不在** `AppSettings` 白名单内 | [settings-store.ts](../src/main/settings-store.ts) `sanitizeSettings` 字段列表 |
| F3 | **计划是「一次一批」**：整批共用**一个** preset 与**一套** argv | [ffmpeg_planner.js](../core/transcode/ffmpeg_planner.js) `prepareFFmpegPlan({ entries, preset, argv, ... })` |
| F4 | **引擎会强制覆盖 entry 上自带的 preset/argv** | 同文件 `buildFFmpegTasks`：`{...entry, preset, argv: structuredClone(argv), testMode, signal, errorFile}` |
| F5 | **任务 id 是位置派生的**：`buildTask` 不生成 id，由信封按位置赋 `task-0/task-1/...` | [ffmpeg_task.js](../core/transcode/ffmpeg_task.js) `buildTask` 返回值无 `id`；[ffmpeg_plan_snapshot.js](../core/transcode/ffmpeg_plan_snapshot.js) `createInternalExecutionPlan`：`id: task.id \|\| task.taskId \|\| \`task-${index}\`` |
| F6 | **index/total 是「每次调用内」按数组位置赋的** | [rename.js](../core/lib/rename.js) `addEntryProps`：`entry.index = index; entry.total = entries.length` |
| F7 | 目标路径由 `argv.output` + `argv.outputMode` + `preset.output` 决定 | ffmpeg_task.js `buildCliTask` 的 `fileDstDir` 三分支（tree 走 `helper.pathRewrite(entry.root, srcDir, preset.output)`） |
| F8 | **preset 实例本身就是「批次级调参的载体」**：`createFromArgv` 把 argv 吸收进 preset | [ffmpeg_presets.js](../core/transcode/ffmpeg_presets.js) `createFromArgv`：读取 `argv.preset / prefix / suffix / output`(→`preset.output`)`/ anime / audioCodec / dimension / speed / framerate / videoCodec / videoBitrate / videoQuality / audioCopy...` |
| F9 | **每个 task 已自带 preset 与 argv** → **执行期**天然支持逐任务不同参数 | ffmpeg_task.js `buildTask` 返回 `{...entry, preset: activePreset, argv, ...}` |
| F10 | 引擎按 `plan.tasks` 的**数组顺序**并发执行 | [ffmpeg_engine.js](../core/transcode/ffmpeg_engine.js) `pMap(tasks, ...)` |
| F11 | manifest（`active-tasks.json`）只服务**临时产物清理**，运行结束即清，**不能当队列用** | [ffmpeg-manifest.ts](../src/main/ffmpeg-manifest.ts) `writeTaskManifest` / `clearTaskManifest`；ffmpeg-service `.finally()` 调 `clearTaskManifest()` |
| F12 | 主进程已有「白名单 + 原子写」的持久化范式可直接复用 | settings-store.ts（tmp + rename、字段收窄、未知字段丢弃） |
| F13 | 每个 e2e 用例已使用独立 `userData`，恢复类用例天然可测 | [fixtures.ts](../tests/e2e/fixtures.ts) |

**F4 是本方案的枢纽**：只要不改引擎，就无法让同一次计划里出现两种 preset ——
因为 entry 上的 preset/argv 会被批次级的值覆盖掉。

---

## 2. 关键设计决策

### D1 持久化「意图」，不持久化「计划产物」

- **存**：源路径、名称、大小、源 mtime、项级覆盖、状态、产物路径、入队时间
- **不存**：`argv`、`hwPlan`、`fileDstTemp`、`mediaInfo` 原始对象
- 理由：`argv`/`hwPlan` 依赖硬件探测结果与 ffmpeg 版本。跨会话复原一份旧 argv，
  会与阶段一刚修好的「探测说有 nvenc、实际不可用」类问题正面冲突；
  `mediaInfo` 体积大且文件可能已被替换。
- 代价：恢复后是「待扫描」状态，需要重建计划（重新探测）。这恰好与现有 STALE 语义一致。

### D2 项级覆盖只覆盖「编码」，不覆盖「位置 / 命名 / 机器能力」（**已确认**，见 §10-1）

| 可逐项 | 保持全局 |
|---|---|
| `preset`、`dimension`、`fps`、`speed`、`videoBitrate`、`videoQuality`、`audioCodec`、`audioBitrate` | `output`、`outputMode`、`prefix`、`suffix`、`jobs`、`hwaccel`、`decodeMode`、`strict`、`override`、`anime`、`deleteSourceFiles` |

理由：一个队列应只有一种输出策略（否则「产物在哪」不可预期，且 `outputMode: tree`
依赖 `entry.root`、`file` 依赖 `preset.output`，逐项化会让路径推导变成组合爆炸）；
机器能力属宿主环境；命名策略逐项化收益低而解释成本高。

> 注：`anime` 严格说属编码侧，但它在 `createFromArgv` 里是**预设别名改写**
> （`hevc_anime` → `hevc_2k` + `isAnime`），所以「用户想给某个动画文件开动漫模式」
> 的正确表达是**选一个动画预设**，而不是加一个逐项开关。故仍保持全局。

### D3 项级预设用「引擎微改」（方案甲），**否决**主进程分组合并（方案乙）

这是本方案最需要拍板的地方，两个方案都可行，代价差距很大。

**方案甲：让 `buildFFmpegTasks` 尊重 entry 自带的 preset/argv**

```js
// core/transcode/ffmpeg_planner.js · buildFFmpegTasks
const prepared = entries.map((entry) => ({
    ...entry,
    // 逐项覆盖优先，未提供时回落到批次级（保持 CLI 与现有调用方行为不变）
    preset: entry.preset || preset,
    argv: entry.argv ? structuredClone(entry.argv) : structuredClone(argv),
    testMode,
    signal,
    errorFile: argv.errorFile,
}))
```

- **一次** `prepareFFmpegPlan` 调用 → F5/F6 的 index/total/id 天然全局正确，
  信封的 `totalDuration`/`totalSize`/`previewCmd` 也天然正确。
- 改动量约 2 行，纯增量；entry 不带 preset 时行为与今天完全一致。
- 代价：触碰 `core/`，需按仓库纪律用真机 ffmpeg 验证（见 §8）。

**方案乙：主进程按 (preset, argv 覆盖) 分组，每组调一次 `prepareFFmpegPlan`，再手工合并内部信封**

必须自己补齐四件事，任何一处漏掉都会变成难查的错位：

1. **重赋 id**：F5 决定每组都产出 `task-0..task-n`，合并即冲突 →
   `taskId` 撞车会让 `task.progress` / `task.done` 事件按 id 找不到任务（表现：进度丢失、状态不更新）；
2. **重排 index**：F6 决定每组 index 从 0 重启 → `#` 列会出现两个「1」，
   `taskIndex` 事件同样错位；
3. **重算信封**：`totalDuration`/`totalSize` 是每组各自的和；
4. **重算 previewCmd**：它按「计划首个任务」生成，分组后语义不明。

外加 `currentPlan.tasks` 与 `stagedEntries` 的引用要重新登记（沿用现有 `createPlan` 里的做法）。

**结论：用方案甲。** 方案乙省下的是「一次引擎改动」，换来的是四处手工重算；
在一个已经因为 index/id 派生方式踩过坑（见阶段一报告 §2）的代码库里，这笔交易不划算。

### D4 队列的属主是主进程

- 与设置同纪律：主进程持有 `queue.json`，收窄校验，渲染层只发**显式意图** IPC。
- **不采用**「渲染层整份快照覆盖」：队列可能上千条，每次改动传全量既浪费又放大竞态。
- 理由：AGENTS.md 明确「主进程侧校验是唯一安全门」；且执行期状态本来就由引擎产生。

### D5 安全：恢复后**绝不自动开始**（本方案最重要的一条）

- 启动只把队列恢复为「待处理」，状态 `READY`/`STALE`，等用户显式点开始。
- 理由：跨会话自动跑批 + 「覆盖已有文件」的组合会造成无人值守的静默覆盖。
- `deleteSourceFiles` 与 `deleteSourceConfirmed` **一律不持久化**，与设置同纪律。
- `override`（覆盖已有文件）保持全局、不落盘。
- **允许「一键继续」**（已确认，见 §10-3）：它是用户的一次显式动作，
  与「自动开始」的区别就是**必须有人点**。语义见 D8。

### D6 崩溃语义

- 队列项状态需在运行中写盘，否则崩溃后无法判断哪一项在跑。
- 规则：状态变更时**防抖**写盘；启动恢复时把 `running` 一律降级为 `interrupted`。
- 与 manifest 的分工：manifest 仍只管临时产物清理（F11），两者互不替代、互不依赖。

### D7 schemaVersion 与迁移

- 顶层 `schemaVersion: 1`；**未知版本不猜**：备份为 `queue.json.bak` 后从空队列启动。
- **单条校验失败只丢这一条**并计数，不让一条脏数据毁掉整个队列。

### D8 「一键继续」的语义（已确认，见 §10-3）

「继续」= 一次用户显式动作，把队列里**尚未完成**的项重建计划并开始执行。

- **参与本轮**：`queued` / `failed` / `cancelled` / `interrupted`
- **默认排除**：`success` / `skipped`（在 UI 上仍然可见，用户可单独勾选强制重跑）
- ⚠️ **与「重建计划」的冲突（必须处理）**：`createPlan` 重建时引擎会把所有任务
  重置为 `pending`，这会**丢掉队列里已知的完成状态**。因此判定必须双轨，不能只信重建结果：
  1. **队列状态** —— 决定 UI 上「哪些项默认参与本轮」；
  2. **引擎侧 `dstExists`** —— 第二道防线（引擎与 `isExecutableTask` 都把
     `dstExists === true` 视为 skipped）。若用户改过全局输出设置，产物路径变化、
     这道防线不生效 → 表现为「重新编码到新位置」，这是符合预期的行为。
- 恢复态是 `STALE`，所以「继续」必须先重建计划再执行（沿用现有隐式重扫描链路）。

---

## 3. 数据模型

`userData/queue.json`：

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-01T12:00:00.000Z",
  "items": [
    {
      "id": "q_1759..._a1b2c3",
      "path": "E:\\media\\a.mkv",
      "name": "a.mkv",
      "size": 123456,
      "srcMtimeMs": 1759000000000,
      "presetOverride": "h264_2k",
      "tuneOverride": {
        "dimension": 0, "quality": 20, "bitrate": "",
        "fps": 0, "speed": 0, "audioCodec": "", "audioBitrate": ""
      },
      "status": "queued",
      "error": null,
      "fileDst": null,
      "enqueuedAt": 1759000000000
    }
  ]
}
```

要点：

- `presetOverride` / `tuneOverride` 为 `null` 表示「跟随全局当前设置」——
  **已确认语义**（见 §10-4）：用户改全局预设后，未覆盖的条目会跟随新预设；
  有覆盖的条目不受全局变化影响，因此需要在 UI 上有可见标记（见 §6）。
- `srcMtimeMs` 用于恢复时判断「源文件已变」（可选，用于给提示，不做强制）。
- `status` 取值：`queued | running | success | failed | skipped | cancelled | interrupted`。
- 契约侧新增 `QueueItem`、`QueueSnapshot`（含 `items` 与派生统计），放进
  [contracts.ts](../src/shared/contracts.ts)。

---

## 4. IPC 契约

| 通道 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `queue:get` | — | `QueueSnapshot` | 启动水合与刷新 |
| `queue:add` | `string[]` | `{ added: QueueItem[]; skippedDuplicates: number; snapshot }` | 目录输入仍走既有展开逻辑 |
| `queue:remove` | `string[]` ids | `snapshot` | 运行中拒绝（沿用 `isExecuting()` 守卫） |
| `queue:reorder` | `string[]` ids（全量顺序） | `snapshot` | 全量顺序比 `move(id,to)` 更易校验：必须与现有 id 集合完全一致 |
| `queue:setOverride` | `id`, `{ preset?, tune? } \| null` | `snapshot` | `null` = 清除覆盖 |
| `queue:clear` | — | `snapshot` | 运行中拒绝 |
| `queue:changed`（事件） | `snapshot` | — | 主进程侧变更（执行期状态回写）广播，避免渲染层轮询 |

全部经 `handleTrusted` 注册，入参一律按 `unknown` 收窄。

---

## 5. 主进程改动

1. **新增 `queue-store.ts`**：仿 settings-store.ts（白名单 + 原子写 tmp→rename + 防抖写盘 +
   单条容错 + 版本处理）。
2. **`ffmpeg-service.ts`**
   - `stagedEntries` 的角色收敛：或直接以 queue store 作为唯一事实源，
     或保留为「内存索引」但以 queue 为准（需明确单一写者，避免两处漂移）。
   - `createPlan`：按**队列顺序**构造 entries，并对每个 entry 附上
     `entry.preset = presets.createFromArgv({ ...globalArgv, ...itemOverride, preset: itemPreset })`
     与 `entry.argv`（依赖 D3 甲）。
   - **逐任务 `cmdPreview`**：`PlanTask.cmdPreview` 字段已存在且
     `createPublicTaskSnapshot` 已透出（F9 附近）。目前只给「计划首个任务」生成
     `plan.previewCmd`，而渲染层 `planStore.previewCmdFor()` 只做**路径字符串替换**，
     不会换编码参数 → 项级预设下，非首项的「命令预览」会显示错误的编码参数。
     **必须在构建期逐任务填充 `cmdPreview`**，并让渲染层优先用它。
   - `startExecution(taskIds)` 语义不变，但顺序取自队列顺序（F10）。
   - 执行期把 `task.started/done/failed/skipped` 回写到队列项状态（防抖）。
   - `initialize()` 读队列，`running` → `interrupted`。
3. **不做的事**：不持久化 `deleteSourceFiles`；不新增自动启动路径。

---

## 6. 渲染层改动

- `planStore` 不再是任务唯一事实源：队列从 `queue:get` 水合；`planSnapshot` 仍代表「本次计划」。
- `TaskTable`：加**上/下移按钮**（不做拖拽，见 §10-2；按钮键盘可达、e2e 也稳定）、
  行右键「为此项设置覆盖…」，以及「**继续处理未完成项**」入口（见 D8）。
- `ConfigPanel`：文案明确「此处是**新入队项的默认值**；已有项可各自覆盖」，
  并在有项级覆盖时给出可见标记（否则用户会困惑「为什么改了全局设置它没变」）。
  全局设置变化时，提示「将影响 N 个未覆盖条目」。
- 新增 `QueueItemOverride` 弹窗：预设下拉 + 视频/音频调参 + 「跟随全局」复位。
- 恢复态：`state-tag` 显示「待扫描（已恢复 N 项）」，且**开始按钮不自动触发**。

---

## 7. e2e 与验收

| 用例 | 断言 |
|---|---|
| 队列持久化 | 加入 3 项 → 关闭 → 重启 → 3 项仍在、顺序一致、状态为待处理且**未自动开始** |
| 项级预设 | 两项设不同 preset → 建计划 → 两项 `targetSummary`/预设名不同 |
| 项级命令预览 | 两项不同 preset → 各自的命令预览含各自编码器（**防 D5 那条回归**） |
| 排序 | 调整顺序后建计划 → `plan.tasks` 顺序与队列一致 |
| 高危不落盘 | `queue.json` 内不含 `deleteSource` 相关字段 |
| 容错 | 写入 `schemaVersion: 999` / 损坏 JSON → 应用正常启动、队列为空、有 `.bak` |
| 崩溃态 | 手工把某项写成 `running` → 重启后为 `interrupted` |
| 一键继续 | 3 项中 1 项 `success`、1 项 `failed`、1 项 `queued` → 点「继续」只处理后两项，`success` 项不被重新编码 |
| 全局跟随 | 一项无覆盖 + 一项有覆盖 → 改全局预设 → 重建后无覆盖项用新预设、有覆盖项不变 |

fixtures 已按用例隔离 userData（F13），这些用例不需要额外隔离手段。

---

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 引擎微改影响 CLI 行为 | 回落默认值保证「无 entry 级 preset 时行为不变」；用真机 ffmpeg 各跑 1 帧 `-f null -` 对比改前改后 argv；同时跑全量 e2e（含 03-workflow 真实转码） |
| 队列与设置双写竞态 | 同一时刻只有主进程一个写者；防抖 + 原子写；渲染层只发意图 |
| 恢复后产物路径与预期不符（用户改了全局输出设置） | 恢复态统一标 `STALE`，强制重建计划后才允许执行 |
| `schemaVersion` 升级后旧代码读新文件 | 未知版本一律忽略并备份；降级后表现为「队列为空」，不会误跑 |
| 队列很大时表格卡顿 | **已知取舍**：本阶段不做虚拟滚动（§10-5）。缓解：先提供条目计数作为观察点，若实际出现上千项再单独立项 |

**回滚**：代码回滚后残留的 `queue.json` 无害（与 `settings.json` 同理，未被读取即不生效）。

---

## 9. 建议分三个 PR

| PR | 内容 | 交付价值 |
|---|---|---|
| PR1 | 队列持久化 + 恢复 + 删除/清空/排序（**不含项级覆盖**） | G1 + G2，且不触碰 `core/` |
| PR2 | 项级预设与调参覆盖（含 D3 引擎微改 + 逐任务 `cmdPreview`） | G3 |
| PR3 | 打磨：剩余调度视图（§11）、删除/清空撤销（§11-#12）、导出队列、崩溃态提示文案、覆盖标记的视觉强化、（按需）虚拟滚动 | 体验 |

先做 PR1 的好处：**它完全不碰引擎**，可以独立验证「持久化 + 恢复 + 绝不自动跑」
这条最关键的链路，把风险与 PR2 隔离开。

---

## 10. 已拍板决策（2026-10-01）

| # | 问题 | 决定 | 影响的设计点 |
|---|---|---|---|
| 1 | 项级覆盖的边界 | **接受**「不含输出位置/命名」 | D2 定稿；不做「项级冻结输出策略快照」，路径推导保持单一路径 |
| 2 | 排序交互 | **不做拖拽**，用上/下移按钮 | §6 交互实现；PR3 不再包含拖拽 |
| 3 | 恢复后的续跑 | **允许一键继续**，但绝不自动开始 | 新增 D8；需增加「继续」入口与两条 e2e |
| 4 | 覆盖项与全局改动的关系 | **未覆盖项跟随全局** | §3 数据模型语义；需「将影响 N 个未覆盖条目」提示 |
| 5 | 队列规模 / 虚拟滚动 | **暂时不做**虚拟滚动 | §8 登记为已知取舍；PR3 降级为按需 |

下表为决策落地点，便于评审时逐条对照：

- 决策 1 → D2、§3、§5「不做的事」
- 决策 2 → §6、§9 PR3
- 决策 3 → D5、D8、§6、§7
- 决策 4 → §3、§6
- 决策 5 → §0 非目标、§8、§9 PR3

---

## 11. 补充：Phase 2 剩余项（#11 其余与 #12）· **待评审**

上游 [UI-UX-REVIEW.md](./UI-UX-REVIEW.md#L146-L148) 的 #11 / #12 在 §0–§10 里未被完整覆盖：
§10-2 只定了手动排序（否决拖拽），未涉及「按列排序 / 批量优先级 / 进度切换」；
#12 的「删除/清空 5 秒撤销」此前不在 §9 PR3 清单内。以下为补入内容，**尚未拍板**。

### D9 排序分两层：队列顺序 vs 视图排序

- **队列顺序**（`queue.json` 的 `items` 数组顺序）= 执行顺序，**只由**上/下移按钮改变。
- **视图排序**（按状态/大小/名称）= 仅改显示，**不写盘、不改执行顺序**；
  处于视图排序态时隐藏上/下移按钮，并提示「排序仅影响视图，不改变处理顺序」。
- 理由：若按列排序也改执行顺序，会与手动上/下移互相打架，「排序后到底先跑哪个」不可预期。

### D10 批量优先级 = 批量位移，不新增 `priority` 字段

- #11 的「批量改优先级」在单序列队列里语义就是位置：多选后提供「**置顶 / 置底 / 上移 / 下移**」。
- 不引入独立 `priority` 数字字段：与现有 `queue:reorder`（全量顺序契约）保持单一排序事实源。
- 运行中拒绝（沿用 `isExecuting()` 守卫）。

### D11 ExecutionBoard「全部 / 仅本批」切换

- 「本批」= 最近一次 `startExecution` **实际提交**的 taskId 集合；主进程随
  `ExecutionSnapshot` 回传该集合（**仅内存，不持久化**）。
- 「全部」= 整个队列按项级状态聚合（`success / failed / skipped / cancelled / interrupted / queued`）。
- 默认显示「本批」；队列为空或从未执行时退回「全部」。

### D12 删除/清空撤销：主进程持有的短时快照

- `queue-store` 保留 `lastRemoval = { items, indices, at }`（**内存，不落盘**），
  覆盖最近一次 `remove` / `clear`。
- 新增 IPC `queue:undo`：窗口期内（5s）按原索引还原；超时或期间已有新的移除则返回
  `{ ok: false, reason }`。
- 因此删除/清空**不再弹二次确认**（#12 原意），改为 toast + 「撤销」按钮。
- 与 D5 无冲突：撤销只还原队列项（`status` 维持移除前的值；`running` 项本就禁止移除）。

### e2e 增补（并入 §7 清单）

| 用例 | 断言 |
|---|---|
| 视图排序 | 按大小排序后显示顺序变化，但 `queue.json` 顺序与 `plan.tasks` 顺序不变 |
| 批量位移 | 多选置顶后执行顺序以被选中项的相对顺序置前 |
| 撤销 | 删除 1 项 → 点撤销 → 按原位置恢复；等待超 5s 再撤销 → 失败且队列不变 |
| 进度切换 | 3 项中完成 2 项后，「仅本批」与「全部」两个进度读数符合各自定义 |
