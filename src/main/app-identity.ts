import { app } from "electron"

/** 应用唯一显示名（与 package.json productName 一致） */
export const APP_NAME = "FFConv GUI"

/**
 * 必须在任何 `app.getPath("userData")` 调用**之前**执行。
 *
 * userData 目录名取自 app.name（默认来自 package.json 的 name 字段 "ffconv-gui"，
 * 而非 productName）。此前 index.ts 在文件体里才 `app.name = ...`，而 ESM import
 * 会先执行 ffmpeg-service.ts 的模块体 —— 其构造器在 import 阶段就用 userData 构造
 * 3 个持久化 store，导致 queue/whitelist/manifest 落在 %AppData%/ffconv-gui、
 * settings.json 落在 %AppData%/FFConv GUI，同一个应用的持久化数据分裂在两个目录。
 * 本模块作为 main 进程**第一个** import（index.ts 与 ffmpeg-service.ts 都引它），
 * 从根源上消除先后顺序问题。
 */
if (app.name !== APP_NAME) {
  app.name = APP_NAME
}
