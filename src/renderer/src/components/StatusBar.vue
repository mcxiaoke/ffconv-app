<script setup lang="ts">
import { computed } from "vue"
import { useEnvStore } from "../stores/env"
import { usePlanStore } from "../stores/plan"
import { useLogStore } from "../stores/log"

const env = useEnvStore()
const plan = usePlanStore()
const logStore = useLogStore()

// 二进制定位来自轻量目录，启动即可用；硬件分层要等探测完成，未完成时显示「探测中」，
// 而不是先误报「未找到 / CPU」再跳变。
const ffmpegStatusText = computed(() => {
  if (env.ffmpegPath) return "ffmpeg: 可用"
  return env.catalog ? "ffmpeg: 未找到" : "ffmpeg: 检测中…"
})

const ffprobeStatusText = computed(() => {
  if (env.ffprobePath) return "ffprobe: 可用"
  return env.catalog ? "ffprobe: 未找到" : "ffprobe: 检测中…"
})

const hwTierText = computed(() => {
  if (!env.hardwareReady) return "硬件加速: 探测中…"
  const tier = env.summary?.hardware.tier || "cpu"
  return `硬件加速: ${tier.toUpperCase()}`
})

const taskSummary = computed(() => {
  if (plan.status === "RUNNING") {
    return `转码中 · 进度 ${Math.round(plan.overallPercent)}%`
  }
  if (plan.status === "PLANNING") {
    return "正在扫描…"
  }
  if (plan.tasks.length === 0) {
    return "就绪 · 请添加文件"
  }
  return `就绪 · ${plan.tasks.length} 个任务`
})

const emit = defineEmits<{
  (e: "open-about"): void
}>()
</script>

<template>
  <footer class="status-bar" data-testid="status-bar">
    <div class="status-left">
      <div class="status-item" :title="env.ffmpegPath || '未配置'">
        <span class="status-dot" :class="{ ok: !!env.ffmpegPath }"></span>
        <span>{{ ffmpegStatusText }}</span>
      </div>
      <div class="status-sep"></div>
      <div class="status-item" :title="env.ffprobePath || '未配置'">
        <span class="status-dot" :class="{ ok: !!env.ffprobePath }"></span>
        <span>{{ ffprobeStatusText }}</span>
      </div>
      <div class="status-sep"></div>
      <div class="status-item" :title="'硬件加速: ' + (env.summary?.hardware.tier || 'cpu')">
        <span class="status-dot" :class="{ ok: env.hardwareReady }"></span>
        <span>{{ hwTierText }}</span>
      </div>
    </div>

    <div class="status-center">
      <span class="task-info">{{ taskSummary }}</span>
    </div>

    <div class="status-right">
      <button
        class="status-btn"
        data-testid="status-about-btn"
        title="查看系统硬件、GPU 及核心环境信息"
        @click="emit('open-about')"
      >
        <span>关于</span>
      </button>
      <div class="status-sep"></div>
      <button
        class="status-btn"
        data-testid="status-log-btn"
        title="日志 (Ctrl+L)"
        @click="logStore.drawerOpen = !logStore.drawerOpen"
      >
        <span class="status-dot" :class="{ err: logStore.errCount > 0, ok: logStore.errCount === 0 }"></span>
        <span>日志{{ logStore.errCount > 0 ? ` (${logStore.errCount} 条错误)` : '' }}</span>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.status-bar {
  height: 24px;
  background: var(--bg-card);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-3);
  flex-shrink: 0;
  user-select: none;
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-center {
  flex: 1;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 16px;
}

.task-info {
  color: var(--text-2);
}

.status-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}

.status-dot.ok {
  background: var(--primary);
}

.status-dot.err {
  background: var(--error);
}

.status-sep {
  width: 1px;
  height: 10px;
  background: var(--border);
}

.status-btn {
  background: transparent;
  border: none;
  font-family: inherit;
  font-size: inherit;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px;
  border-radius: 3px;
  transition: background 0.12s;
}

.status-btn:hover {
  background: var(--bg-hover);
  color: var(--text-base);
}
</style>
