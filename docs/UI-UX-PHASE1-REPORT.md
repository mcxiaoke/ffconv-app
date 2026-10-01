# 实施报告 · UI/UX 阶段一

> 日期：2026-10-01　分支：`master`
> 前置文档：[UI-UX-REVIEW.md](./UI-UX-REVIEW.md)（问题盘点与对标）、
> [UI-UX-PHASE1-PLAN.md](./UI-UX-PHASE1-PLAN.md)（施工单与逐项状态）
> 本文件是**交付记录**：做了什么、为什么这么做、验证到什么程度、什么没做。

## 0. 一句话

补齐 FFmpeg GUI 在日常使用上最短的那几块板：**设置不再每次启动复位**、
**预设不再等硬件探测**、**错误不再弹原生框**、**任务多了能找到**、
**键盘与主题可用**，并给这些行为补上自动化回归。

## 1. 交付清单

### 1.1 设置持久化（本次最大的一项）

| | |
|---|---|
| 问题 | `preset / tune / adv / outputMode / prefix / suffix / outputDir` 全为硬编码初值，localStorage 只存主题与工具路径 → 每次启动复位，设置面板改了也白改 |
| 改动 | 新增 [settings-store.ts](../src/main/settings-store.ts)：原子写 `userData/settings.json`（tmp + rename），**所有入参经白名单校验与收窄**后再落盘；契约加 `AppSettings`，通道加 `settings:get` / `settings:set`；渲染层 `config.ts` 增 `hydrate()` 与 400ms 防抖回写，`App.vue` 在 `fetchEnv` 之前水合 |
| 关键决策 | **`deleteSource` 刻意不进入持久化形状**——高危开关绝不跨会话自动继承；`savedCustomOutputDir` 属于「记忆」而非「当前值」，重置时保留 |
| 文件 | `src/main/settings-store.ts`(新)、`src/shared/contracts.ts`、`src/shared/ipc-channels.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/stores/config.ts`、`src/renderer/src/App.vue` |

### 1.2 预设加载与硬件探测解耦（启动卡顿）

| | |
|---|---|
| 问题 | 启动后左侧「预设 / 视频 / 音频」要等 1~2 秒才渲染 |
| 根因 | `FfmpegEnvironment.getSummary()` 是一条串行链：定位二进制 → 预设 YAML → **硬件探测** → ffprobe 版本；而渲染层拿预设的唯一途径就是这次 `getEnvironment()`，预设被排在硬件之后 |
| 实测 | 轻量目录 **15 ms**（29 个预设）　vs　完整摘要 **2083 ms** |
| 改动 | 新增 `PresetCatalog` 契约与 `env:get-presets` 通道，只做「二进制定位 + 分层预设」；`envStore` 拆 `fetchPresets()`（轻量，启动首个 await）与 `fetchEnv()`（硬件，后台补齐），统一预设来源 `env.presets` |
| 附带修正 | 原 `presets: bundled default not found at <路径>` 是**误报日志**：它在 `initPresetsAsync()` 之前判断空注册表（首次必然命中），且打印的就是解析成功的路径 → 改为加载后仍为空才抛错 |
| 文件 | `src/main/ffmpeg-environment.ts`、`src/main/ffmpeg-service.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/stores/env.ts`、`src/renderer/src/App.vue`、`src/renderer/src/components/ConfigPanel.vue`、`src/renderer/src/components/StatusBar.vue` |

> 注意：这 2 秒**没有消失，只是离开了关键路径**。硬件能力在扫描/建计划时确实要用；
> 现在启动即后台发起 `fetchEnv()`，用户点「扫描」时通常已缓存。

### 1.3 错误反馈：toast 取代原生 `alert()`

| | |
|---|---|
| 问题 | 3 处 `alert()`（未添加输入、扫描失败、工具路径失败）——阻断、不可复制、风格割裂，且会冻结渲染 |
| 改动 | 新增 [useToast.ts](../src/renderer/src/composables/useToast.ts) + [ToastHost.vue](../src/renderer/src/components/ToastHost.vue)；错误用 `role="alert"`，其余 `role="status"`；`SettingsModal` 失败时保持弹窗打开的既有行为不变 |

### 1.4 任务表：搜索 / 筛选 / 排序 / 失败详情

| | |
|---|---|
| 问题 | `v-for` 全量渲染、表头无交互（上千文件找不到目标）；失败原因只藏在状态徽章的 `title` 里 |
| 改动 | 工具条加搜索（匹配源名/路径/目标名）与状态筛选、`N / M` 计数、`大小`/`时长` 可排序列（带 `aria-sort`）；失败行可展开一行详情，提供「复制错误」「查看日志」 |
| 边界 | 只影响**展示**，不动 `selectedIds` / `activeTaskId` / 执行顺序；`#` 列恒为计划序号 |

### 1.5 「文件与输出」分组重置

| | |
|---|---|
| 问题 | 视频/音频有「恢复预设值」，而最易残留脏值的输出位置/目录结构/前缀/后缀没有任何回退入口 |
| 改动 | 卡片标题右侧加同款入口（仅在有脏值时出现，`重置 (n)`）：`outputDirtyCount` + `resetOutputSettings()` |
| 刻意不做 | 不重置 **输入清单**（用户挑的素材，不是参数）与 `savedCustomOutputDir`（自定义目录的记忆） |

### 1.6 无障碍与主题

- `useFocusTrap`：模态打开即聚焦、`Tab`/`Shift+Tab` 在弹窗内循环、关闭后焦点归位；
  接入设置与关于两个弹窗，并给关于弹窗补上 `role="dialog" aria-modal="true"`。
- `theme.css` 加 `@media (prefers-reduced-motion: reduce)`。
- 日志面板改用 CSS 变量，修复浅色主题下仍是写死 `#0d1117` 的割裂。
- 状态栏在环境未就绪时显示「检测中 / 探测中」，不再先误报「未找到 / CPU」再跳变。

### 1.7 测试基础设施与回归

| | |
|---|---|
| 新增 | [06-phase1.spec.ts](../tests/e2e/specs/06-phase1.spec.ts)，7 个用例覆盖上述全部功能面 |
| 必要修复 | [fixtures.ts](../tests/e2e/fixtures.ts) 改为**每个用例一份独立 `--user-data-dir`** |
| 原因 | 加持久化后，03-workflow 写入的输出模式/目录被 02-interaction 继承（扫描拿到不存在的目录 → 开始按钮禁用）。这不是持久化的 bug，而是 e2e 原本依赖「设置是临时的」 |

## 2. 过程中踩到并修掉的两个坑

1. **`Error launching app / Unable to find Electron app at <项目>\tests`**
   新 spec 位于 `tests/e2e/specs/`，比 `fixtures.ts` 深一层，却照抄了
   `path.resolve(__dirname, "../../")`，`appRoot` 因此算成 `<项目>/tests`。
   修正为三层，并把启动逻辑抽成 fixtures 导出的 `launchElectronApp()`，spec 不再自己拼路径。
2. **真实 `settings.json` 被 e2e 污染**（内容是 `tests/temp/...` + `dimension 1280`，
   明显来自 03-workflow）。隔离 userData 后不再发生；已清理该文件恢复默认。

## 3. 验证与证据

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm run build` | 通过 |
| `npm run test:e2e` | **19/19 通过**（原 12 + 新增 7） |
| `SettingsStore` 白名单/收窄/原子写 | 一次性脚本 21 项断言全过（含 `deleteSource` 不入盘、非法枚举回退、损坏 JSON 返回 null、patch 合并保留他字段），验证后已删除脚本 |
| 环境通道耗时 | `getPresetCatalog()` 15 ms　vs　`getSummary()` 2083 ms |

新增回归用例：

| 用例 | 覆盖 |
|---|---|
| 重启后恢复预设/调参/高级选项 | 写盘内容 + **真正关闭再重启**后 UI 还原 + `deleteSource` 不入盘也不继承 |
| toast 取代原生 alert | 出现 toast，且 `window.alert` 调用数为 0 |
| 搜索 / 状态筛选 / 排序 | 条数、计数、排序方向，且只影响展示 |
| 「文件与输出」分组重置 | 脏值计数、一键恢复默认，且不清掉已添加的素材 |
| 模态焦点陷阱 | 打开即聚焦、Tab/Shift+Tab 不逃逸、关闭后焦点归位 |
| 预设通道不阻塞 | 轻量通道 < 1s（实测 ~15ms），防止硬件探测被重新塞回该路径 |
| 日志面板跟随主题 | 两主题背景不同，浅色不再是写死的 `#0d1117` |

## 4. 未做（已在计划文档中单列）

| 项 | 原因 |
|---|---|
| 扫描可取消 + 进度上报 | 需引擎在 `core/transcode/**` 分批上报并支持中断，触碰引擎边界 |
| UI i18n | 需全量字符串抽取 + 语言包 + 与 `core/lib/i18n.js` 术语对齐 |
| 输出体积预估 | 需契约新增 `estimatedSize` 并由引擎估算 |
| 任务表虚拟滚动 | 筛选/排序已解决「找不到」；纯性能项，可随时补 |
| 失败详情的自动化 | 在 e2e 里构造**确定性失败**的转码需要坏素材或坏编码器路径，代价高于收益，保留手工验证 |
| 硬件探测结果缓存 | 能把首屏之外的 2 秒也省掉，但需设计失效条件（换卡/升驱动），否则会制造更难查的问题 |

## 5. 已知取舍

- 筛选状态下的「全选」仍作用于**全部任务**，保留既有 `planStore.toggleAll` 语义，
  避免在同一轮里改动选中模型。
- 快捷键速查弹窗、命令面板未做。
- 「文件与输出」只做了整组重置，未做逐字段脏值圆点 + 单项撤销（视频/音频已有）。

## 6. 约定更新

[AGENTS.md](../AGENTS.md) 增加三处约定：

1. 新增可持久化设置的落点与「必须同步 `sanitizeSettings` 白名单」的要求，
   并明确**高危开关不得进入持久化形状**；
2. 每个 e2e 用例使用独立 `--user-data-dir`；
3. 跑 e2e 前须先关掉正在运行的实例（`requestSingleInstanceLock()` 失败会让新实例立即退出，
   表现为 `Error launching app` / `Process failed to launch`）。
