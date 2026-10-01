# 第一阶段实施计划 · 低风险快赢

> 上游评审见 [UI-UX-REVIEW.md](./UI-UX-REVIEW.md) 第 4 节「阶段一」。
> 本文件是**可执行的施工单**：每项都锚定了真实文件、改动边界、验收方式与风险。
> 状态列在实现过程中就地更新。

## 目标

在不改动转码引擎（`core/**`）与计划/执行协议的前提下，补齐「日常可用性」短板：
设置不丢、错误不弹原生框、任务多了能找到、失败看得见、无障碍可用。

## 硬约束（来自 AGENTS.md）

- `src/renderer/` 不得 import `core/` 或 Node 专有模块；一切经 typed IPC 契约。
- `core/` 不得 import `src/`。本阶段**不动** `core/`。
- 新增渲染层运行时依赖才进 `dependencies`；本阶段**不引入新依赖**。
- 主进程调用引擎仍只经 `core/transcode/index.js` facade（本阶段不新增引擎调用）。
- 持久化落在 `app.getPath("userData")`，与 `active-tasks.json`、`authorized-paths.json` 同级。

## 不在本阶段范围

- 队列持久化 / 项级预设覆盖（阶段二，触及 `currentPlan` 模型）。
- 扫描可取消 + 进度上报（需要引擎分批上报，属阶段一 #5，**本轮不做**，见「遗留」）。
- UI i18n（需要全量字符串抽取，单独立项，见「遗留」）。
- 输出体积预估（需要契约新增 `estimatedSize` 与引擎估算，见「遗留」）。
- 任务表虚拟滚动（先做筛选/排序；虚拟滚动在「遗留」中列为独立项）。

## 任务清单

| ID | 任务 | 涉及文件 | 风险 | 状态 |
|----|------|----------|------|------|
| T1 | 设置持久化 | `shared/contracts.ts`、`shared/ipc-channels.ts`、`main/settings-store.ts`(新增)、`main/index.ts`、`preload/index.ts`、`renderer/stores/config.ts`、`renderer/App.vue` | 中 | ✅ 已完成 |
| T2 | 应用内 toast 取代 `alert()` | `renderer/composables/useToast.ts`(新增)、`renderer/components/ToastHost.vue`(新增)、`App.vue`、`SettingsModal.vue` | 低 | ✅ 已完成 |
| T3 | 任务表搜索 / 状态筛选 / 排序 | `renderer/components/TaskTable.vue` | 中 | ✅ 已完成（虚拟滚动除外） |
| T4 | 失败原因可视化 | `renderer/components/TaskTable.vue` | 低 | ✅ 已完成 |
| T5 | 无障碍与主题打磨 | `renderer/composables/useFocusTrap.ts`(新增)、`SettingsModal.vue`、`AboutModal.vue`、`styles/theme.css`、`LogDrawer.vue` | 低 | ✅ 已完成 |

---

### T1 · 设置持久化

**问题**：`config.ts` 的 `preset/tune/adv/outputMode/prefix/suffix/outputDir` 全是硬编码初值，
localStorage 只存主题、工具路径、抽屉宽度 → 每次启动复位，设置面板改了也白改。

**契约**（`src/shared/contracts.ts`）：

```ts
export interface AppSettings {
  preset: string
  outputDir: string
  outputBesideSource: boolean
  savedCustomOutputDir: string
  outputMode: "tree" | "dir" | "file"
  prefix: string
  suffix: string
  tune: { dimension; quality; bitrate; fps; speed; audioCodec; audioBitrate }
  adv: { hwaccel; decodeMode; jobs; override; anime; strict }
  // 刻意排除 deleteSource：不持久化「转码后删除源文件」，
  // 避免下次启动自动继承高危开关
}
```

**主进程** `src/main/settings-store.ts`（新增，仿 `FfmpegManifest`）：

- 构造入参为文件路径；`load()` 读不到/解析失败 → 返回 `null`（不阻塞启动）。
- `save(patch)`：**白名单校验**（仅已知 key + 类型/枚举/范围），合并后写
  `${path}.tmp` 再 `rename`（原子写）。
- 校验要点：`jobs` 夹到 1–8；`quality` 0–51；`dimension/fps/speed` ≥ 0；
  `outputMode ∈ {tree,dir,file}`；字符串字段截断长度上限。

**IPC**：

- `IPC_CHANNELS.SETTINGS_GET = "settings:get"` → `AppSettings | null`
- `IPC_CHANNELS.SETTINGS_SET = "settings:set"` → 入参 `unknown`，走 `handleTrusted`，
  非对象即抛错；返回合并后的 `AppSettings`。

**preload**：`getSettings()` / `saveSettings(settings)`，沿用 `safeClone`。

**渲染层** `config.ts`：

- `hydrate()`：`await window.api.getSettings()` → 逐字段应用到已有 ref，
  **不覆盖** `deleteSource`；应用后置 `hydrated = true`。
- `snapshotForPersist(): AppSettings`：导出可持久化子集（剔除 `deleteSource`）。
- 内部 `watch` 上述字段（deep）→ 400ms 防抖 → `saveSettings(snapshot)`；
  `hydrated` 为 false 时直接返回（避免用默认值覆盖磁盘）。

**`App.vue`**：`onMounted` 里在 `fetchEnv()` **之前**调 `configStore.hydrate()`，
保证「预设是否存在」的校验基于已恢复的预设。

**验收**：

1. 改预设 / 分辨率 / CRF / 并发 / 输出目录 → 重启应用，全部还原。
2. 勾选「转码后删除源文件」→ 重启后该开关为**关闭**。
3. 手动把 `settings.json` 写成非法 JSON / 非法枚举 → 应用正常启动，退回默认值。
4. `settings.json` 只含白名单字段（构造一个多余字段的 payload，落盘后不出现）。

---

### T2 · 应用内 toast 取代 `alert()`

**问题**：`App.vue`（未添加输入、扫描失败）、`SettingsModal.vue`（工具路径失败）
用原生 `alert()`——阻断、不可复制、风格割裂，且在 Electron 中冻结渲染。

**实现**：`useToast()`（模块级单例队列，`id/type/message`，默认 4s 自动消失，
可手动关闭）+ `ToastHost.vue`（fixed 定位，`aria-live`：错误 `assertive`，
其余 `polite`）。挂到 `App.vue` 根部。

**替换点**：`App.vue` 两处 `alert` 改为 `toast.push(msg, "error")`；
`SettingsModal.vue` 一处 `alert` 改为 `toast.push(msg, "error")`。
`SettingsModal` 失败时**保持弹窗打开**的既有行为不变。

**验收**：未添加输入点「扫描」→ 出现错误 toast（非原生框），可读可关；
工具路径填错保存 → 错误 toast + 弹窗仍在。

---

### T3 · 任务表搜索 / 状态筛选 / 排序

**问题**：`v-for="task in planStore.tasks"` 全量渲染，表头无交互；上千文件时找不到目标。

**实现**（仅 `TaskTable.vue`）：

- 表格上方工具条：搜索输入（匹配文件名/源路径/目标路径，防抖非必需）、
  状态下拉（全部/等待中/转码中/完成/失败/已跳过）、`N / M` 计数、清除按钮。
- 排序：`大小`、`时长` 两列表头可点击，`asc/desc` 切换，表头带 `aria-sort`；
  `#` 列恒为计划序号（`task.index + 1`），不随排序变化。
- 渲染改为遍历 `visibleTasks`（`tasks` 过滤 + 稳定排序的 computed）。
- 过滤/排序**只影响展示**，不影响 `selectedIds`、`activeTaskId`、执行顺序。
- 空结果时显示「无匹配任务」占位，不清空真实任务。

**验收**：搜索「TEST2」只剩匹配行；筛「失败」只显示失败行；按大小降序首行最大；
勾选状态在筛选切换后保持不变；`#` 列序号不错乱。

---

### T4 · 失败原因可视化

**问题**：失败原因只在状态徽章的 `title` 里，需悬停才可见。

**实现**：`TaskTable.vue` 中失败行状态列加「详情」按钮，展开一行
`<tr class="err-row">`（`colspan` 跨列）显示 `task.error` 全文 + 「复制」按钮 +
「查看日志」（复用 `logStore.focusTask`）。再次点击收起。同一时刻只展开一行。

**验收**：失败行点「详情」→ 在行下展示完整错误文本；「复制」写入剪贴板；
「查看日志」打开日志抽屉并聚焦该任务。

---

### T5 · 无障碍与主题打磨

1. `useFocusTrap(containerRef, isActive)`（新增）：激活时把焦点移入容器首个可聚焦元素，
   拦截 `Tab`/`Shift+Tab` 循环，失活时把焦点还给打开前的元素。
   接入 `SettingsModal.vue`、`AboutModal.vue`（两者已有 `role="dialog" aria-modal="true"`）。
2. `styles/theme.css` 加 `@media (prefers-reduced-motion: reduce)`：把动画/过渡时长压到近 0。
3. `LogDrawer.vue` 的日志区改用 CSS 变量（`--log-bg/--log-text/--log-ts/--log-*-c`），
   在 `theme.css` 的 light/dark 各自定义——修复浅色主题下日志区仍是深色 `#0d1117` 的割裂。

**验收**：设置弹窗打开后 Tab 只在弹窗内循环，Esc/关闭后焦点回到触发按钮；
系统开启「减少动态效果」后脉冲/滑入动画停止；浅色主题下日志区为浅色。

---

## 遗留（本阶段未做，需单独立项）

| 项 | 原因 | 前置条件 |
|----|------|----------|
| 扫描可取消 + 进度 | 需引擎在 `core/transcode/**` 分批上报并支持中断，触碰引擎边界 | 引擎 IPC 事件扩展 + 取消信号 |
| UI i18n | 需全量字符串抽取 + 语言包 + 与 `core/lib/i18n.js` 术语对齐 | `vue-i18n` 依赖决策 |
| 输出体积预估 | 需 `MediaTargetSummary` 新增 `estimatedSize` 并由引擎估算 | 契约 + 引擎改动 |
| 任务表虚拟滚动 | 先做筛选/排序解决「找不到」；纯性能项 | 无（可随时做） |
| 快捷键速查弹窗 | 体验增强，非阻塞 | 无 |

## 验证方式

- `npm run typecheck`（vue-tsc web + tsc node）
- `npm run lint`
- `npm run build` 通过；e2e 现有 5 个 spec 不回归（素材缺失时相关用例本就跳过）

## 完成记录

- **T1～T5 均已实现**，`npm run typecheck` / `npm run lint` / `npm run build` 全绿；
  e2e **17/17 通过**（原 12 个 + 本阶段新增 5 个）。
- T1 的 `SettingsStore` 白名单/收窄/原子写另用一次性脚本核验 21 项断言（含
  `deleteSource` 不入盘、非法枚举收回退、损坏 JSON 返回 null、patch 合并保留他字段），
  全部通过后已删除脚本。
- 已知取舍：任务表的「全选」仍作用于**全部任务**而非当前筛选结果（保留既有
  `planStore.toggleAll` 语义，避免在同一轮里改动选中模型）；筛选/排序只影响展示。

## 新增回归覆盖（`tests/e2e/specs/06-phase1.spec.ts`）

| 用例 | 覆盖点 |
|------|--------|
| 重启后恢复预设/调参/高级选项 | T1：写盘内容、关闭→重启后 UI 还原、`deleteSource` 不入盘也不继承 |
| toast 取代原生 alert | T2：出现 `[data-testid=toast]`，且 `window.alert` 调用次数为 0 |
| 搜索 / 状态筛选 / 排序 | T3：条数、计数、排序方向；确认只影响展示 |
| 模态焦点陷阱 | T5：打开即聚焦、Tab/Shift+Tab 均不逃逸、关闭后焦点归位 |
| 「文件与输出」分组重置 | 脏值计数、一键恢复默认，且不清掉已添加的素材 |
| 日志面板跟随主题 | T5：浅色/深色背景不同，且浅色不再是写死的 `#0d1117` |

## 追加：「文件与输出」分组重置

原先只有「视频」「音频」两卡有「重置」（恢复**预设**值），而最易残留脏值的
输出位置 / 目录结构 / 前缀 / 后缀没有任何回退入口。现于该卡标题右侧加同款入口：

- 仅在有脏值时显示，文案为 `重置 (n)`（与视频/音频一致）；标题为「恢复默认值」——
  这组没有预设参与，基准是默认值（同级目录 / 保留上级文件夹名 / 无前后缀）。
- 新增 `outputDirtyCount` 与 `resetOutputSettings()`（[config.ts](../src/renderer/src/stores/config.ts)）。
- 刻意**不**重置两个东西：输入清单（用户挑的素材，不是参数）与
  `savedCustomOutputDir`（上次自定义目录的记忆，取消「与同级」时还能用回来）。

## 追加：预设加载与硬件探测解耦

**现象**：启动后左侧「预设 / 视频 / 音频」要等 1~2 秒才渲染。

**原因**：`FfmpegEnvironment.getSummary()` 是一条串行链——
`ensureFfmpegPath → resolveFFprobeBinary → 预设 YAML → detectHardwareCapabilities
→ resolveFfprobeVersion`，而渲染层拿预设的**唯一**途径就是这次 `getEnvironment()`。
硬件探测要跑 `ffmpeg -version`、枚举 244 个编码器、再按 GPU 矩阵逐项探测
（日志 `encode=10 / decode=22`，最多 30+ 次 ffmpeg 调用）。实测：轻量目录 **15 ms**
vs 完整摘要 **2083 ms**。

**改动**：

- 新增 `PresetCatalog` 契约与 `env:get-presets` 通道，只做「二进制定位 + 分层预设」；
- `envStore.fetchPresets()` 先跑，`fetchEnv()` 后台补齐；统一预设来源 `env.presets`，
  ConfigPanel 与 App 的预设有效性校验都改走它；
- 状态栏在硬件未就绪时显示「探测中…」，不再先误报「未找到 / CPU」再跳变；
- 顺手修掉 `presets: bundled default not found at <路径>` 这行**误报日志**——
  它原本在加载前判断空注册表（必然命中），且打印的就是解析成功的路径。

**回归**：e2e 断言轻量通道 < 1s（实测约 15ms），防止硬件探测日后被重新塞回该路径。

**为让回归可重复，e2e 基础设施做了一处必要调整**：`tests/e2e/fixtures.ts` 现在给
**每个用例启动一份独立 `--user-data-dir`**。原因：设置持久化之后，03-workflow 写入的
输出模式/目录会被 02-interaction 继承（扫描拿到不存在的目录 → 开始按钮被禁用）；
隔离 userData 同时也让 e2e 不再改写开发机上的真实 `settings.json`。
T4（失败详情）未加自动化：在 e2e 里构造一个**确定性失败**的转码需要坏素材或坏编码器路径，
代价高于收益，保留为手工验证项。
