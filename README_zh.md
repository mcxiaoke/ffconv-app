# FFConv GUI

基于 Electron + Vue 3 的 FFmpeg 可视化转码客户端。把 FFmpeg 的编码器、滤镜与
硬件加速能力封装成图形化工作流：选择文件或目录 → 选预设 → 检查生成的命令计划
→ 执行转码并实时查看进度 —— 默认先 dry-run，确认后才真正写盘。

原 `mediac` CLI 工具箱已从本仓库退役（另行归档），本仓库现在只承载桌面应用
及其转码引擎。

## 功能特性

- **预设驱动转码** —— 分层 YAML 预设（`presets/default.yaml`，支持 `extends`
  继承与 `_override` 覆盖），是音频/视频目标的唯一事实源。
- **硬件加速分层** —— 自动探测 NVENC / QSV / AMF 与 GPU 能力，无法满足时
  自动回退软件编码。
- **计划 → 确认 → 执行** —— 每个任务执行前展示完整 FFmpeg 命令、源/目标与
  预估体积；未经确认不写入任何文件。
- **实时任务看板** —— 逐任务进度、日志、重试/跳过原因与结果快照；完成后
  可自动清理源文件。
- **自定义工具路径** —— 可在设置面板中指定自备的 ffmpeg/ffprobe。

## 环境要求

- Node.js >= 22
- FFmpeg + FFprobe：经 `FFMPEG_PATH` / `FFPROBE_PATH` 环境变量、设置面板指定，
  或位于 `PATH`（解析顺序：设置面板自定义路径 → `FFMPEG_PATH`/`FFMPEG_BINARY`
  → 自带 `resources/ffmpeg/` → `PATH`）

### 自带 FFmpeg（可选）

把 `ffmpeg.exe` 和 `ffprobe.exe` 放进 `resources/ffmpeg/`（见该目录内 README），
执行 `package:win` 时即随安装包分发，并在运行时优先于 `PATH` 使用。目录留空时
打包照常成功，应用回退到环境变量 / 设置面板 / `PATH`，行为与之前一致。二进制
不入库（gitignore），仅提交 README 以锚定目录存在。

## 开发运行

```bash
npm install
npm run dev          # 启动应用（electron-vite dev）
npm run dev:debug    # 开启 Chromium 远程调试 :9222
```

## 检查与打包

```bash
npm run typecheck    # vue-tsc (web) + tsc (node)
npm run lint         # eslint（应用 TS/Vue + core/ 引擎 JS）
npm run build        # 打包 main/preload/renderer 到 out/
npm run test:e2e     # Playwright 端到端测试（需本地素材，见下）
npm run package:win  # 构建 + electron-builder（nsis/portable/zip）→ release/
```

e2e 依赖本地（已 gitignore）素材 `data/videos/TEST2__h264_60fps_1080.mp4` 与
`TEST2__hevc_60fps_1080.mp4`；文件缺失时相关用例跳过。

## 仓库结构

```
├─ src/        Electron 应用：main / preload / renderer / shared
├─ core/       转码引擎（纯 JS ESM）
│  ├─ transcode/  ffmpeg 计划/拼装/执行、预设、硬件加速、GPU、扫描
│  ├─ lib/        共享工具（日志、i18n、媒体解析等）
│  └─ assets/     CJK 文件名归一化用汉字数据
├─ presets/    默认预设文件（打包为 extraResource）
├─ tests/e2e/  Playwright 端到端用例
└─ docs/ffmpeg/  编码器/硬件加速参考资料与指南
```

渲染进程不直接接触文件系统与 FFmpeg：全部经类型化 IPC 契约（`src/shared/`）
进入主进程，主进程只通过 `core/transcode/index.js` facade 调用引擎。

## 许可证

[Apache-2.0](LICENSE)
