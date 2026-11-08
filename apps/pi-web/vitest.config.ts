import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// 单测目录只覆盖纯模块（无 DOM、无 electron / node-pty / ssh2 依赖）。
// 与 vite.config.ts 保持同一别名口径：前端与宿主共享的纯模块统一从 pi-web-host 的
// 并入源目录取，避免出现 apps/pi-web/server 第二份快照。
const root = dirname(fileURLToPath(import.meta.url));

/**
 * 覆盖率口径（P9，2026-11-08）：
 * 只统计 P3/P4 已移植的纯函数模块（66 个），门槛 90/85/90（docs/03 §4 纯函数 ≥90）。
 * 实测（P9 收口时）：95.86 lines / 88.77 branches / 97.84 functions。
 * 组件（jsdom，P6）与 React hooks（use-chat 等）不在本口径内。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@urchin/pi-web-host/shared': resolve(root, '../../packages/pi-web-host/src/pi-server'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
      'src/message-delta.ts',
      'src/streaming-cues.ts',
      'src/stream-markdown.ts',
      'src/chunk-recovery.ts',
      'src/aborted-turn.ts',
      'src/banner-notice.ts',
      'src/conversation-order.ts',
      'src/conv-groups.ts',
      'src/unread-conversations.ts',
      'src/history-window.ts',
      'src/lazy-window.ts',
      'src/optimistic-queue.ts',
      'src/prompt-history.ts',
      'src/composer-draft.ts',
      'src/composer-bridge.ts',
      'src/chat-input-backspace.ts',
      'src/at-mention.ts',
      'src/slash-filter.ts',
      'src/session-url.ts',
      'src/copy-text.ts',
      'src/left-sections.ts',
      'src/ui-locale.ts',
      'src/ui-layout-edit.ts',
      'src/cache-stats.ts',
      'src/tool-args.ts',
      'src/tool-schema.ts',
      'src/tool-info-state.ts',
      'src/tool-inspector-state.ts',
      'src/scm-commit-history.ts',
      'src/scm-history-filter.ts',
      'src/scm-sidebar.ts',
      'src/format-bytes.ts',
      'src/base-url.ts',
      'src/code-lines.ts',
      'src/scm-quote.ts',
      'src/protocol-version.ts',
      'src/canvas-mentions.ts',
      'src/clipboard-files.ts',
      'src/device-center-setup.ts',
      'src/file-preview-bridge.ts',
      'src/file-tree-hidden.ts',
      'src/group-capabilities.ts',
      'src/image-lightbox-bridge.ts',
      'src/ime-guard.ts',
      'src/mobile-runtime.ts',
      'src/new-chat-request.ts',
      'src/notice-policy.ts',
      'src/panel-sash.ts',
      'src/pick-locale.ts',
      'src/plugin-phase.ts',
      'src/plugin-setting-options.ts',
      'src/present-items.ts',
      'src/preset-plugins.ts',
      'src/preview-toc.ts',
      'src/question-attachments.ts',
      'src/question-nav.ts',
      'src/quick-phrases.ts',
      'src/search-folded.ts',
      'src/skill-block.ts',
      'src/swipe-drawer.ts',
      'src/term-touch.ts',
      'src/token-input.ts',
      'src/topbar-fit.ts',
      'src/tts-client.ts',
      'src/update-command.ts',
      'src/workspace-file-url.ts',
      ],
      thresholds: {
        lines: 90,
        statements: 90,
        branches: 85,
        functions: 90,
      },
    },
  },
});
