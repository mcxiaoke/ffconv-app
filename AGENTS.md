# AGENTS.md

本文档为 AI 编码助手（Claude Code 及其他通用 agent）提供在此仓库中工作的指导。

> 本仓库原为 mediac CLI 单体仓库，现已收敛为 **FFmpeg Electron GUI 应用仓库**：
> 应用位于仓库根（原 `apps/mediac-desktop`），转码引擎归入 `core/`，CLI 代码已删除。

## 项目概述

MediaCli Desktop（包名 `mediac-desktop`，Electron + Vue 3 + Pinia）是 FFmpeg 的
可视化转码客户端：选文件/目录 → 选预设 → 检查命令计划 → 执行转码，默认 dry-run、
确认后执行。主进程经 `core/transcode/index.js` facade 使用全部转码能力。

## 命令和工作流

```bash
npm install          # 安装依赖（Node >= 22，ESM）
npm run dev          # 启动应用（electron-vite dev）；dev:debug 加远程调试 :9222
npm run typecheck    # vue-tsc (web) + tsc (node)
npm run lint         # eslint（应用 TS/Vue + core/ 引擎 JS，flat config 见 eslint.config.js）
npm run build        # 打包 main/preload/renderer 到 out/（同时拷贝 presets 到 out/presets）
npm run test:e2e     # Playwright 端到端测试
npm run package:win  # build + electron-builder（nsis/portable/zip）→ release/
```

发布产物布局由 `electron-builder.yml` 决定：`extraResources` 打入根 `presets/`，
asar 内只含 `out/**` 与 `package.json`。

## 模块结构与依赖边界

- `src/main/`：Electron 主进程（窗口、菜单、IPC、`ffmpeg-service.ts` 任务编排、
  `ffmpeg-environment.ts` 二进制定位与硬件探测）。**只经 `../../core/transcode/index.js`
  facade 调用引擎**，禁止深导入 `core/transcode/*` 内部模块或 `core/lib/*`。
- `src/preload/`、`src/shared/`：类型化 IPC 契约。renderer/preload 不得 import
  `core/` 与 Node 专有模块（preload 产物为 CJS）。
- `src/renderer/`：Vue 3 + Pinia 渲染层，不接触文件系统与 ffmpeg，全部走 IPC。
- `core/transcode/`：转码引擎（纯 JS ESM，无 TS）。`index.js` 是唯一对外 facade；
  改动导出面时须同步更新主进程调用点。
- `core/lib/`：引擎共享工具（日志 `debug.js`、i18n、媒体解析、编码探测等）；
  `core/assets/hanzi/` 为简繁转换数据（`core/lib/unicode.js` 以 import attributes 加载）。
- `presets/default.yaml`：内置预设唯一事实源（分层 YAML，支持 `extends` 与
  `_override`）；加载逻辑在 `core/transcode/preset_loader.js`。
- `docs/ffmpeg/`：编码器/硬件加速参考资料；`docs/ffmpeg/FFMPEG-USAGE.md` 是
  预设与参数的权威说明。
- 边界约束：`core/` 不得 import `src/`；依赖闭包所需的 npm 包已全部声明在
  `package.json` devDependencies 并列入 `electron.vite.config.ts` 的
  `externalizeDepsPlugin` exclude（main 产物全打包，仅外置 electron 与 node 内建模块）。

## 国际化与日志

- 引擎侧消息用 `core/lib/i18n.js` 的 `t("key", { param: value })` 中英双语，
  自动检测系统语言；新增引擎消息须同时补两种语言。
- 引擎日志统一经 `core/lib/debug.js`（loglevel + prefix）。

## 测试

- 测试为 Playwright e2e（`tests/e2e/`），先 `npm run build` 再 `npm run test:e2e`。
- e2e 素材为本地不入库的 `data/videos/TEST2__h264_60fps_1080.mp4` 与
  `TEST2__hevc_60fps_1080.mp4`；素材缺失时相关用例会失败，新跑环境需先补素材。
- `data/`、`out/`、`release/`、`temp/`、`test-results/` 均不入库。

## FFmpeg 参数修改纪律

- 改动 `core/transcode/` 的编码/滤镜参数前，须用真机 `ffmpeg -h encoder=X`
  与 1 帧 `-f null -` 逐选项核验，勿凭文档臆造调优项。
- 开发机本机预装多版本 ffmpeg，位于 `C:\Home\Apps\ffmpeg`（每目录内含
  `ffmpeg.exe`/`ffprobe.exe`）：
  - `bin` → **N-126733（master，2026-09-20）**：开发默认，PATH 中的 `ffmpeg` 即指向它；
  - `ff7` → n7.1.1；`ff8` → 8.1.2；`ff9` → 9.0.1（gyan.dev）；
  - `nomercy-ffmpeg-8` → 8.1.2；`nomercy-ffmpeg-9` → 9.0（NoMercy MediaServer）；
  - 另含 `NVEncC`/`QSVEncC`/`VCEEncC` 等编码 CLI。
  - 跨版本验证或复现版本差异时，以绝对路径调用对应版本（如 `C:\Home\Apps\ffmpeg\ff9\ffmpeg.exe`）。

## 常见开发任务

### 新增转码能力/预设字段

1. 在 `core/transcode/` 对应模块实现（options → build → plan → run 链路），
   schema 校验在 `preset_schema.js`
2. 若新增 facade 导出，更新 `core/transcode/index.js` 与主进程调用点
3. 在 `presets/default.yaml` 暴露对应预设字段，并在 `docs/ffmpeg/FFMPEG-USAGE.md` 补文档
4. 用 `npm run dev` 手工验证 + e2e 回归

### 添加依赖

- 构建期依赖（引擎闭包用包）：`npm install --save-dev [package]`，并同步加入
  `electron.vite.config.ts` 的 exclude 列表（保持打进 main bundle 的行为）
- 渲染层运行时依赖（需 electron-builder 打入 asar node_modules 的）才放 `dependencies`
- 确保兼容 ES 模块

## 环境要求

- Node.js **>= 22**（`package.json` engines，ES 模块）
- 外部工具：ffmpeg、ffprobe（必需）；`mediainfo` CLI 可选（ffprobe 失败时的兜底探测）
- 二进制定位优先级：`FFMPEG_PATH` → `FFMPEG_BINARY` → 设置面板自定义路径 → `PATH`（`which`）
