import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import vue from "@vitejs/plugin-vue"

const appRoot = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = path.resolve(appRoot, "../..")

const copyCoreData = {
  name: "copy-core-data",
  writeBundle() {
    const presetOutputDir = path.join(appRoot, "out/presets")
    fs.mkdirSync(presetOutputDir, { recursive: true })
    fs.copyFileSync(
      path.join(coreRoot, "presets", "default.yaml"),
      path.join(presetOutputDir, "default.yaml"),
    )
  },
}

export default defineConfig({
  main: {
    plugins: [
      copyCoreData,
      externalizeDepsPlugin({
        // 转码引擎闭包依赖全部打进 bundle（main 产物仅外置 electron 与 node 内建模块）
        exclude: [
          "chalk",
          "cli-progress",
          "dayjs",
          "execa",
          "fdir",
          "fs-extra",
          "iconv-lite",
          "js-xxhash",
          "js-yaml",
          "loglevel",
          "loglevel-plugin-prefix",
          "music-metadata",
          "p-map",
          "systeminformation",
          "which",
        ],
      }),
    ],
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [vue()],
  },
})
