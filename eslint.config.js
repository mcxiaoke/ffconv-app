// ===========================================
// ESLint flat config（仓库唯一配置）
// ===========================================
//
// 仓库构成：Electron 应用（TypeScript + Vue SFC：main / preload / renderer）
// + 转码引擎 core/（纯 JavaScript ESM）。后者需要 vue-eslint-parser 之外
// 的普通解析即可，与 TS 部分共用本配置。
//
// 规则取向（刻意克制，避免变成格式化工具）：
//   - 只启用能发现**真实缺陷**的规则集：js/ts recommended（未使用变量、未定义引用、
//     条件恒真、catch 静默等）+ eslint-plugin-vue 的 essential（v-if/v-for 误用、
//     重复 key、模板解析错误、未注册组件等）；
//   - 不引入 vue/recommended 与 @stylistic 之类含排版主张的规则，否则会对既有代码
//     产生数百条纯格式告警，把真实问题淹没；
//   - 类型感知规则（需 type-check）不开：会让 lint 依赖 tsconfig 全量类型检查，
//     慢且与 `npm run typecheck` 职责重叠。
import js from "@eslint/js"
import pluginVue from "eslint-plugin-vue"
import tseslint from "typescript-eslint"
import globals from "globals"

export default tseslint.config(
    // 构建产物、测试产物与临时目录不参与
    {
        ignores: [
            "out/**",
            "release/**",
            "build/**",
            "node_modules/**",
            "test-results/**",
            "temp/**",
            "tests/temp/**",
        ],
    },

    js.configs.recommended,
    ...tseslint.configs.recommended,
    ...pluginVue.configs["flat/essential"],

    // Vue SFC：<script setup lang="ts"> 需要把内层解析器指向 TS
    {
        files: ["**/*.vue"],
        languageOptions: {
            parserOptions: {
                parser: tseslint.parser,
                ecmaVersion: "latest",
                sourceType: "module",
            },
        },
        rules: {
            // 单文件组件名规则不适用于入口组件 App.vue（Vue 官方也建议关掉）
            "vue/multi-word-component-names": "off",
        },
    },

    // 转码引擎 core/（纯 JS ESM）：Node 环境。
    // 遗留代码大量使用 `cond && action()` 守卫与 `_` 前缀的占位参数，
    // 按其惯例放宽对应规则（仅限 core/，应用 TS 侧保持默认严格度）。
    {
        files: ["core/**/*.js"],
        languageOptions: {
            globals: { ...globals.node },
        },
        rules: {
            "@typescript-eslint/no-unused-expressions": [
                "error",
                { allowShortCircuit: true, allowTernary: true },
            ],
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrors: "none",
                },
            ],
        },
    },

    // 渲染进程：浏览器环境（含 window/document/localStorage 等）
    {
        files: ["src/renderer/**/*.{ts,vue}"],
        languageOptions: {
            globals: { ...globals.browser },
        },
    },

    // 主进程 / preload / 共享契约 / 构建与测试脚本：Node 环境
    {
        files: [
            "src/main/**/*.ts",
            "src/preload/**/*.ts",
            "src/shared/**/*.ts",
            "*.ts",
            "tests/**/*.{ts,js}",
        ],
        languageOptions: {
            globals: { ...globals.node },
        },
    },

    // 打包后置脚本是 CommonJS：require() 在这里是正确写法，
    // typescript-eslint 的 no-require-imports 面向 ESM 代码，此处必须关掉
    {
        files: ["scripts/**/*.cjs"],
        languageOptions: {
            globals: { ...globals.node },
            sourceType: "commonjs",
        },
        rules: {
            "@typescript-eslint/no-require-imports": "off",
        },
    },

    // 项目既有约定：IPC/第三方库边界上显式 any 是刻意的（如 currentPlan、execa 返回值），
    // 一次性改成精确类型属于独立重构，这里降级为 warn，保留可见性但不阻断门禁。
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "warn",
        },
    },

    // ===========================================
    // 依赖边界门禁（AGENTS.md「模块结构与依赖边界」的可执行化）。
    // no-restricted-imports 的 patterns 按 import 书写串做 gitignore 式匹配，
    // 因此用 **/core/** 形态同时覆盖相对路径（../../core/…）与别名两种写法。
    // ===========================================

    // 主进程：只允许经 core/transcode/index.js facade 使用引擎，
    // 禁止深导入 core/transcode/* 内部模块与 core/lib/*
    {
        files: ["src/main/**/*.ts"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: [
                                "**/core/transcode/**",
                                "!**/core/transcode/index.js",
                                "!**/core/transcode/index",
                                "**/core/lib/**",
                            ],
                            message:
                                "src/main 只允许经 core/transcode/index.js facade 调用引擎（AGENTS.md 依赖边界）",
                        },
                    ],
                },
            ],
        },
    },

    // preload / renderer：不得 import core/（一切经 typed IPC），不得导入 Node 专有模块
    //（preload 产物为 CJS，renderer 无 Node 权限；Node API 需求一律加到 preload 契约里）
    {
        files: ["src/preload/**/*.ts", "src/renderer/**/*.{ts,vue}"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: ["**/core/**"],
                            message:
                                "preload/renderer 不得 import core/，只经 src/shared 契约的 typed IPC（AGENTS.md 依赖边界）",
                        },
                        {
                            group: [
                                "node:*",
                                "fs",
                                "fs/promises",
                                "path",
                                "os",
                                "crypto",
                                "child_process",
                                "stream",
                                "url",
                                "util",
                                "events",
                            ],
                            message: "preload/renderer 不得导入 Node 专有模块（AGENTS.md 依赖边界）",
                        },
                    ],
                },
            ],
        },
    },

    // 转码引擎 core/：不得反向 import src/
    {
        files: ["core/**/*.js"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: ["**/src/**"],
                            message: "core/ 不得 import src/，宿主能力经 facade 参数注入（AGENTS.md 依赖边界）",
                        },
                    ],
                },
            ],
        },
    },
)
