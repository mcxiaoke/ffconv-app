<script setup lang="ts">
import { useToast } from "../composables/useToast"

const { toasts, dismiss } = useToast()
</script>

<template>
  <!--
    提示挂载点。容器带 aria-live，错误用 role="alert"（assertive）即时播报，
    其余用 role="status"（polite），避免多条提示同时抢读屏。
  -->
  <div class="toast-host" data-testid="toast-host">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="`toast-${t.type}`"
        :role="t.type === 'error' ? 'alert' : 'status'"
        data-testid="toast"
      >
        <span class="toast-msg selectable">{{ t.message }}</span>
        <button class="toast-x" title="关闭" aria-label="关闭提示" @click="dismiss(t.id)">✕</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: 14px;
  /* 让出底部状态栏（24px）的高度 */
  bottom: 34px;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: min(460px, 60vw);
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 10px 9px 12px;
  border: 1px solid var(--border-strong);
  border-left-width: 3px;
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--text-base);
  box-shadow: var(--shadow);
  font-size: 12px;
  line-height: 1.5;
}

.toast-msg {
  flex: 1;
  min-width: 0;
  word-break: break-word;
  white-space: pre-wrap;
}

.toast-x {
  flex: none;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  border-radius: 3px;
  font-size: 11px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.toast-x:hover {
  background: var(--bg-hover);
  color: var(--text-base);
}

.toast-info {
  border-left-color: var(--info);
}
.toast-success {
  border-left-color: var(--primary);
}
.toast-warn {
  border-left-color: var(--warning);
}
.toast-error {
  border-left-color: var(--error);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(8px);
}
</style>
