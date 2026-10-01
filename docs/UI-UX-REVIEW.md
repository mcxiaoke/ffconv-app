# MediaCli Desktop — UI/UX 评审与对标改进路线图

> 评审范围：`src/renderer/**`（全部组件/store/契约）、`src/main/index.ts` 窗口与菜单。
> 对标对象：HandBrake、Shutter Encoder、FFmpeg Batch AV Converter、FastFlix、VidCoder、
> Tdarr、Adobe Media Encoder。
> 结论按「本仓库内可验证的问题 → 与业界的差距 → 分阶段改进」组织。

---

## 0. 结论摘要

界面的**基础质量明显高于多数 FFmpeg GUI**：计划→确认→执行的心智模型清晰，命令预览、
逐任务进度、时长加权的总进度、ETA/速度、STALE 追踪、脏值/重置、原生删源确认、
退出前置守卫、结构化日志与按任务聚焦，这些都是同类工具里少见的成熟细节。

真正的差距不在「好不好看」，而在**三处结构性能力**：

1. **队列是「一次计划」而不是「队列」** —— 不持久、不可排序、全批只能一个预设；
2. **设置不持久** —— 除主题/工具路径/抽屉宽度外，预设、调参、高级选项每次启动复位；
3. **「所见即所得」缺失** —— 无预览、无裁剪、无输出体积预估，命令预览在未扫描时是靠
   预设名字符串猜测的「估算」，与真实执行可能不一致。

另有若干可直接修的体验问题：扫描期不可取消且无进度反馈、任务表无搜索/排序/虚拟滚动、
错误只用原生 `alert()`、渲染层无 i18n、日志面板固定深色。

---

## 1. 现有交互模型盘点

```
HeaderBar（扫描 / 开始 / 测试 / 停止 / 清空 / 主题 / 日志 / 设置）
  └─ .layout
       ├─ aside.side  → ConfigPanel（文件与输出 · 预设 · 视频 · 音频）
       ├─ .side-resizer
       └─ main
            ├─ HeroEmpty（空态） | TaskTable（任务表 + 右键菜单）
            └─ ExecutionBoard（进度条 / 任务 / 速度 / 剩余 / 打开输出目录）
  └─ StatusBar（ffmpeg / ffprobe / 硬件加速 / 任务摘要 / 关于 / 日志）
  └─ TaskInspectorDrawer（媒体信息 + FFmpeg 命令）
  └─ LogDrawer（等级筛选 / 按任务聚焦 / 复制 / 宽度拖拽）
  └─ SettingsModal（主题 / 硬件加速 / 解码 / 并发 / 4 个开关 / 工具路径）
  └─ AboutModal、GlobalDropMask
```

**做得好的部分（建议保留并写入文档）**

- 计划先于执行：`plan → READY → RUNNING`，`STALE/hasStaged` 会在开始时隐式重扫描（[App.vue](../src/renderer/src/App.vue)）。
- 进度口径正确：总进度按时长加权，部分执行时分母用本轮执行子集（[plan.ts](../src/renderer/src/stores/plan.ts)）。
- 参数级脏值 + 单项重置 + 整组重置（`resetParam` / `resetVideoTune`）。
- 命令语法高亮、复制结果校验（不再谎报「已复制」）。
- 右键菜单支持 `Shift+F10` / ContextMenu 键呼出并聚焦，`Esc`、`Ctrl+B`、`Ctrl+Enter` 齐备。
- 删源这类不可撤销操作由主进程原生对话框确认，安全门不由渲染层自证。

---

## 2. 本仓库内可验证的问题（按严重度）

### P0 — 结构性 / 数据与信任

| # | 问题 | 证据 | 影响 |
|---|------|------|------|
| P0-1 | **配置不持久化**：`config.ts` 的 `preset: "hevc_2k"`、`tune`、`adv`、`outputMode`、`prefix/suffix` 均为硬编码初值；localStorage 只存主题、工具路径、抽屉宽度 | [config.ts](../src/renderer/src/stores/config.ts)、[App.vue](../src/renderer/src/App.vue) onMounted | 每次启动用户都要重选预设、重设并发/加速/覆盖等；「设置」面板改了也白改 |
| P0-2 | **队列不持久**：计划只活在内存（主进程仅有 staged 输入清单与活动任务 manifest） | [ffmpeg-service.ts](../src/main/ffmpeg-service.ts) | 关窗/崩溃后已完成/待办队列全部丢失，无法「攒批过夜跑」 |
| P0-3 | **全批单一预设**：`config.preset` 全局唯一，计划里所有任务共用；不能给某个文件换预设 | ConfigPanel 预设卡、`planSnapshot.presetName` | 混合批次（动画 x265 + 实拍 h264）无法一次处理，被迫拆成多轮 |
| P0-4 | **命令预览在未扫描时是猜测**：按预设名 `includes("hevc"/"265"/"av1"...)` 猜编解码器与 CRF | [TaskInspectorDrawer.vue](../src/renderer/src/components/TaskInspectorDrawer.vue) `cmdString` | 用户看到 `-crf 23`，实际执行可能是 `-crf 28`；即便标注「估算」，也属于误导性信任缺口 |

### P1 — 日常可用性

| # | 问题 | 证据 | 影响 |
|---|------|------|------|
| P1-1 | **扫描（PLANNING）不可取消、无进度**：扫描按钮在 PLANNING 时 `disabled`，停止按钮仅在 RUNNING/STOPPING 可用；无逐文件扫描事件 | [HeaderBar.vue](../src/renderer/src/components/HeaderBar.vue) | 误拖入一个几万文件的目录后，界面只能干等，无法中止 |
| P1-2 | **任务表无搜索 / 排序 / 筛选 / 虚拟滚动**：`v-for="task in planStore.tasks"` 全量渲染，表头无交互 | [TaskTable.vue](../src/renderer/src/components/TaskTable.vue) | 上千文件时卡顿，且找不到「只看失败的」「按大小排」 |
| P1-3 | **错误反馈用原生 `alert()`**：扫描失败、未添加输入、工具路径失败各处 | App.vue ×2、SettingsModal.vue ×1 | 阻断式、不可复制、风格割裂，且在 Electron 中会冻结渲染 |
| P1-4 | **渲染层无 i18n**：全部字符串硬编码中文（引擎有 `core/lib/i18n.js`，README 为英文） | 全组件 | 非中文用户无法使用；与「i18n 中英双语」的仓库约定不一致 |
| P1-5 | **列表删除/清空无撤销**：右键「从列表移除」「删除所选」「清空列表」立即生效 | TaskTable/TaskContextMenu | 误删大批任务只能重新添加 |
| P1-6 | **任务失败信息只在 `title` 里**：状态徽章的 `title=task.error`，需悬停才能看到 | TaskTable 状态列 | 失败原因不显眼，新用户找不到 |
| P1-7 | **无输出体积 / 压缩比预估**：契约无 `estimatedSize` 字段 | [contracts.ts](../src/shared/contracts.ts) `targetSummary` | 与 README「estimated size before anything runs」的承诺不符 |

### P2 — 打磨与无障碍

| # | 问题 | 证据 |
|---|------|------|
| P2-1 | 模态框无焦点陷阱/焦点恢复：标注 `role="dialog" aria-modal="true"`，但未 trap Tab、未在打开时聚焦、关闭后未归位 | SettingsModal/AboutModal |
| P2-2 | 任务行不可键盘聚焦：只有复选框 `tabindex=0`，行本身无 roving tabindex | TaskTable |
| P2-3 | 无 `aria-live`：进度、toast、日志错误无朗读播报 | ExecutionBoard/StatusBar |
| P2-4 | 无 `prefers-reduced-motion` 处理：pulse、slide、bar 过渡始终生效 | theme.css 及各组件 |
| P2-5 | 日志面板在浅色主题下仍固定深色 `#0d1117` | LogDrawer `.log-body` |
| P2-6 | 无快捷键速查（只有零散 `title` 提示），无命令面板 | HeaderBar/App |
| P2-7 | `hello`/`测试`（dry-run）按钮命名模糊，靠 `title` 解释 | HeaderBar `btn-dry-run` |
| P2-8 | 高级项（并发/加速/解码/覆盖/动漫/严格）藏在设置弹窗，与「转码设置」侧栏割裂 | ConfigPanel vs SettingsModal |

---

## 3. 与业界同类的差距

| 能力 | 本项目 | HandBrake | Shutter Encoder | FFmpeg Batch | FastFlix | Tdarr |
|------|--------|-----------|-----------------|--------------|----------|-------|
| 队列持久化 / 关机重启续跑 | ✗ | ✓ | 部分 | ✓ | ✓ | ✓✓（服务化） |
| 队列排序 / 优先级 | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 每文件独立预设/覆盖 | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 视频预览 / 区间预览 | ✗ | ✓（帧预览+区间） | ✓（时间轴） | ✗ | ✓（缩略图网格） | 部分 |
| 裁剪 / 裁切 / 旋转 / 去隔行 | ✗ | ✓ | ✓✓ | 部分 | ✓ | ✓ |
| 字幕：烧录 / 内嵌 / 轨道选择 | ✗ | ✓ | ✓ | 部分 | ✓ | ✓ |
| 音轨选择 / 声道 / 采样率 | 仅编码+码率 | ✓✓ | ✓✓ | 部分 | ✓ | ✓ |
| 输出体积预估 / 目标大小模式 | ✗ | 部分 | 部分 | ✗ | ✓ | ✗ |
| 两遍编码 / 恒定量化曲线说明 | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 观看目录 / 自动处理 | ✗ | ✗ | ✗ | 部分 | ✗ | ✓✓ |
| 暂停 / 恢复 | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| 硬件编码器细分选项（预设/前瞻/码控） | 仅档位选择 | ✓ | ✓ | 部分 | ✓ | ✓ |
| 任务表搜索/筛选/排序 | ✗ | 队列有按状态 | ✓ | ✓ | ✓ | ✓✓ |
| 国际化（多语言 UI） | ✗ | ✓（社区） | ✓ | ✓ | ✓ | ✓ |
| 崩溃后恢复 / 断点 | 部分（活动 manifest） | 部分 | ✗ | ✓ | 部分 | ✓ |

**读法**：本项目当前定位更像「单批、单预设、确定型」的批处理工作台。要贴近 HandBrake /
Tdarr，需要补的是**队列模型**与**所见即所得**；要贴近 Shutter Encoder，需要补**完整滤镜面**。

---

## 4. 改进路线图

### 阶段一 · 低风险快赢（1–2 天，不动架构）

1. **设置持久化**：把 `config` store（预设 / tune / adv / outputMode / prefix / suffix /
   输出目录偏好）落主进程 `userData/settings.json`（或复用现有 manifest 模式），
   启动时 `hydrate()`。*这是投入产出比最高的一项。*
2. **替换 `alert()`**：统一为应用内 toast（可复用 logStore 或新增 `useToast`），
   `role="status"` + `aria-live="polite"`；失败类用 `assertive`。
3. **任务表增强**：加搜索框（文件名/路径）、状态筛选 chips、按列排序（大小/时长/状态）、
   `只勾选」与「全选」联动提示。列表 > 300 行时上虚拟滚动。
4. **失败可视化**：状态列失败时展示可展开的错误摘要 + 「复制错误」，不再只靠 `title`。
5. **扫描可取消 + 有进度**：主进程扫描分批上报 `plan.progress`；HeaderBar 在 PLANNING
   时把「扫描」变为「取消扫描」。
6. **UI i18n 落地**：接入 `vue-i18n`，中文为基准包，抽 `zh-CN`/`en-US`；语言跟随系统 +
   设置项可覆盖。与 `core/lib/i18n.js` 术语表对齐（扫描/预设/CRF 等）。
7. **无障碍与打磨**：模态焦点陷阱 + 打开聚焦 + 关闭归位；行级 roving tabindex；
   `prefers-reduced-motion`；日志面板跟随主题；补「快捷键」速查弹窗。
8. **输出体积预估**：引擎侧按码率/CRF 粗估并在 `targetSummary` 增加 `estimatedSize`，
   任务表加「预计大小 / 压缩比」列，兑现 README 承诺。

### 阶段二 · 队列模型（约 1 周，触及核心）

9. **持久队列**：把当前 `currentPlan` 升级为可序列化的 `QueueItem[]`（源、预设、
   每项覆盖、状态、产物），落 `userData/queue.json`，启动恢复为「已完成/待办」两段。
10. **每项独立预设 / 覆盖**：`ConfigPanel` 顶部保留「当前项设置」，双击任务行进入
    「该项覆盖」编辑；计划生成时合并全局默认 + 项级覆盖。
11. **排序与调度**：拖拽排序、按状态/大小排序、批量改优先级；`ExecutionBoard` 增加
    「全部 / 仅本批」进度切换。
12. **排序后安全网**：删除/清空提供 5 秒撤销（`Undo` 队列），无需二次确认弹窗。

### 阶段三 · 所见即所得（2–3 周，产品差异化）

13. **预览与区间**：接入 `<video>`/canvas 抽帧预览，支持起止裁剪（`-ss/-to`），
    预设侧即时反映到命令预览（用真实 `buildResult.args`，而不是名字猜测，见 P0-4）。
14. **滤镜面补全**：裁剪/裁切/旋转/去隔行/字幕烧录与轨道选择/多音轨选择/声道与采样率/
    两遍编码/目标大小模式；在预设 YAML 与 `preset_schema.js` 同步扩展。
15. **目标大小模式**：输入期望体积 → 反推码率（单遍/两遍），配合体积预估实时显示。
16. **观看目录（可选，对标 Tdarr）**：设置若干 in/out 目录 + 预设，后台自动处理新文件。

### 阶段四 · 规模化与平台化（按需）

17. 队列并发可视化（jobs>1 时的多轨甘特）、暂停/恢复、失败自动重试策略 UI。
18. 任务表导出 CSV/JSON、预设编辑器（可视化编辑 YAML）、预设导入导出与社区分享。
19. 系统托盘 + 完成通知策略（总是/仅失败/从不），最小化到托盘继续跑。

---

## 5. 建议的验收指标

- 冷启动后 100% 还原上次预设与高级设置（阶段一 #1）。
- 1 万文件目录下任务表滚动 ≥ 50fps，扫描可中止（阶段一 #3/#5）。
- 队列跨重启零丢失；混合预设批次一次跑完（阶段二 #9/#10）。
- 未扫描状态下命令预览与真实执行 `argv` 完全一致（阶段三 #13）。
- `eslint-plugin-vuejs-accessibility` 零 error；模态焦点陷阱有 e2e 覆盖（阶段一 #7）。

---

## 6. 附：需要同步更新的文档

- [README.md](../README.md)：`estimated size` 承诺与实现对齐（阶段一 #8 落地后成立）。
- [AGENTS.md](../AGENTS.md)：若新增 `vue-i18n`，需记录渲染层 i18n 约定与语言包位置。
- `docs/ffmpeg/FFMPEG-USAGE.md`：滤镜面补全后同步参数说明。
