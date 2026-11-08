import { defineConfig } from 'vitest/config';

/**
 * pi-web-host 测试配置
 *
 * 覆盖率口径（P9，2026-11-08）：
 * - legacy 范围（排除 src/pi-server 与 src/browser）：门槛 75%（docs/03 §4 legacy ≥75）
 * - pi-server 按「有测试的模块集合」单独口径：门槛 65/80/75
 *   实测（P9 收口时）：legacy 80.75/81.74/88.00，pi-server 68.73/84.09/81.62
 *   （lines/statements、branches、functions）
 * 未纳入 include 的 pi-server 文件即尚无直接测试，不计入分母；
 * 新增测试时把它加入下面的 pi-server include 列表。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 超时放宽（2026-11-08）：本包含真实 git / 子进程与「100 份随机转录」类重算法用例，
    // 默认 5s 在 --coverage（workspace 并发 + v8 插桩）下会因 CPU 争抢偶发超时。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        // legacy 源码（排除 pi-server / browser）
        'src/agent-bridge.ts',
        'src/auth.ts',
        'src/entry.ts',
        'src/file-ops.ts',
        'src/git-ops.ts',
        'src/http-static.ts',
        'src/index.ts',
        'src/model-admin/atomic-file.ts',
        'src/model-admin/dispatch.ts',
        'src/model-admin/i18n.ts',
        'src/model-admin/json-utils.ts',
        'src/model-admin/model-admin.ts',
        'src/model-admin/model-enrich.ts',
        'src/model-admin/protocol-types.ts',
        'src/model-admin/provider-oauth-flow.ts',
        'src/model-admin/runtime-holder.ts',
        'src/pi-server-ready.ts',
        'src/plugin-host.ts',
        'src/plugin-manager.ts',
        'src/plugin-permissions.ts',
        'src/server.ts',
        'src/session-store.ts',
        'src/ssh-client.ts',
        'src/terminal.ts',
        'src/types.ts',
        'src/ws-handler.ts',
        // pi-server 有直接测试的模块
        'src/pi-server/approval-rules.ts',
        'src/pi-server/atomic-file.ts',
        'src/pi-server/compacted-history.ts',
        'src/pi-server/compaction-instructions.ts',
        'src/pi-server/compaction-markers.ts',
        'src/pi-server/compaction-state.ts',
        'src/pi-server/context-budget.ts',
        'src/pi-server/context-evidence.ts',
        'src/pi-server/context-usage.ts',
        'src/pi-server/dangling-tools.ts',
        'src/pi-server/file-archives.ts',
        'src/pi-server/file-save.ts',
        'src/pi-server/file-transfer-routes.ts',
        'src/pi-server/files-service.ts',
        'src/pi-server/hashline-engine.ts',
        'src/pi-server/host-guard.ts',
        'src/pi-server/i18n.ts',
        'src/pi-server/launch-origin.ts',
        'src/pi-server/locales.ts',
        'src/pi-server/message-deletion.ts',
        'src/pi-server/message-window.ts',
        'src/pi-server/native-cli-model.ts',
        'src/pi-server/net-guard.ts',
        'src/pi-server/payload-limits.ts',
        'src/pi-server/permission-preset.ts',
        'src/pi-server/plan-mode.ts',
        'src/pi-server/preset-share.ts',
        'src/pi-server/prompt-composer.ts',
        'src/pi-server/protocol.ts',
        'src/pi-server/queue-modes.ts',
        'src/pi-server/remote-ssh-service.ts',
        'src/pi-server/request-context.ts',
        'src/pi-server/scm-commitmsg.ts',
        'src/pi-server/scm.ts',
        'src/pi-server/serialize.ts',
        'src/pi-server/session-branch.ts',
        'src/pi-server/session-list-scan.ts',
        'src/pi-server/session-open.ts',
        'src/pi-server/session-parser.ts',
        'src/pi-server/session-scan.ts',
        'src/pi-server/session-search.ts',
        'src/pi-server/soft-cap.ts',
        'src/pi-server/themes.ts',
        'src/pi-server/tool-approval.ts',
        'src/pi-server/tool-guards.ts',
        'src/pi-server/tool-info.ts',
        'src/pi-server/tool-manager.ts',
        'src/pi-server/tool-overrides.ts',
        'src/pi-server/tool-prompt-overrides.ts',
        'src/pi-server/transcript-prepare.ts',
        'src/pi-server/uploads.ts',
        'src/pi-server/wait-subscription-scan.ts',
      ],
      thresholds: {
        'src/*.ts': {
          lines: 75,
          statements: 75,
          branches: 75,
          functions: 75,
        },
        'src/model-admin/**': {
          lines: 75,
          statements: 75,
          branches: 75,
          functions: 75,
        },
        'src/pi-server/**': {
          lines: 65,
          statements: 65,
          branches: 80,
          functions: 75,
        },
      },
    },
  },
});
