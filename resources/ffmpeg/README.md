# 自带 FFmpeg（可选）

把以下两个文件放进本目录，即可随安装包（`package:win`）一起分发，并在运行时
**优先于 PATH** 中的 ffmpeg 使用：

```
ffmpeg.exe
ffprobe.exe
```

- 本目录内容（除本说明文件外）不纳入 git（见根 `.gitignore`）。
- 留空时打包照常成功，应用回退到环境变量 / 设置面板 / PATH 定位。
- 建议使用体积较小的 essentials 构建，控制安装包体积。
- 开发态（`npm run dev`）同样会优先使用本目录的二进制。
- 二进制定位整体优先级：设置面板自定义路径 → `FFMPEG_PATH`/`FFPROBE_PATH`
  等环境变量 → 本目录 → PATH（见 `src/main/ffmpeg-environment.ts` 的
  `bundledFfmpegCandidates` 与 `core/transcode/ffmpeg_bin.js`）。
