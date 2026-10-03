# FFConv GUI

A cross-platform desktop GUI for FFmpeg, built with Electron + Vue 3. It turns
FFmpeg's encoder/filter/hardware-acceleration capabilities into a visual
transcoding workflow: pick files or folders, choose a preset, review the
generated command plan, then run jobs with live progress — dry-run first by
default.

The former `mediac` CLI toolbox has been retired from this repository; it now
hosts the desktop app and its transcoding engine only.

## Highlights

- **Preset-driven transcoding** — layered YAML presets (`presets/default.yaml`,
  supports `extends` inheritance and per-key `_override`) as the single source
  of truth for audio/video targets.
- **Hardware acceleration tiers** — automatic detection of NVENC / QSV / AMF
  and GPU capabilities, with sensible fallback to software encoding.
- **Plan → confirm → execute** — every job shows the exact FFmpeg command,
  source/destination and estimated size before anything runs; nothing is
  written unless you say so.
- **Live task board** — per-task progress, logs, retry/skip reasons and result
  snapshots; completed sources can be cleaned up automatically.
- **Custom tool paths** — point the app to your own ffmpeg/ffprobe builds from
  the Settings panel.

## Requirements

- Node.js >= 22
- FFmpeg + FFprobe available via `FFMPEG_PATH` / `FFPROBE_PATH`, or on `PATH`
  (resolution order: Settings-panel custom path → `FFMPEG_PATH`/`FFMPEG_BINARY`
  → bundled `resources/ffmpeg/` → `PATH`)

### Bundled FFmpeg (optional)

Drop `ffmpeg.exe` and `ffprobe.exe` into `resources/ffmpeg/` (see its README)
and they are shipped inside the Windows package via `package:win`, taking
priority over `PATH` at runtime. Leave the directory empty and packaging still
succeeds — the app falls back to env vars / Settings / `PATH` as before. The
binaries are git-ignored; only the README is committed to keep the directory
alive.

## Development

```bash
npm install
npm run dev          # start the app (electron-vite dev)
npm run dev:debug    # with Chromium remote debugging on :9222
```

## Checks & packaging

```bash
npm run typecheck    # vue-tsc (web) + tsc (node)
npm run lint         # eslint (app TS/Vue + core/ engine JS)
npm run build        # bundle main/preload/renderer into out/
npm run test:e2e     # Playwright e2e (needs local fixtures, see below)
npm run package:win  # build + electron-builder (nsis/portable/zip) -> release/
```

e2e specs use the local (git-ignored) fixture `data/videos/TEST2__h264_60fps_1080.mp4`
and `TEST2__hevc_60fps_1080.mp4`; tests that depend on them are skipped when the
files are absent.

## Repository layout

```
├─ src/        Electron app: main / preload / renderer / shared
├─ core/       Transcoding engine (plain JS ESM)
│  ├─ transcode/  ffmpeg plan/build/run, presets, hwaccel, gpu, scanning
│  ├─ lib/        shared utilities (logging, i18n, media parsing, …)
│  └─ assets/     hanzi charset data used for CJK filename normalization
├─ presets/    default preset file (bundled as an extraResource)
├─ tests/e2e/  Playwright end-to-end specs
└─ docs/ffmpeg/  encoder/hwaccel reference notes and guides
```

The renderer never touches the filesystem or FFmpeg directly; everything goes
through a typed IPC contract (`src/shared/`) into the main process, which calls
the engine exclusively via the `core/transcode/index.js` facade.

## License

[Apache-2.0](LICENSE)
