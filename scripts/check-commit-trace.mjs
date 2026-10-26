/**
 * 提交追溯信息检查（AGENTS.md §五.5）
 *
 * §五.5 要求每次提交标注：生成模型/版本、触发指令摘要、相关 Loop 迭代轮次。
 * 第二轮审计发现 24 条历史提交 0 条包含该信息，commitlint 也不校验——
 * 该条款此前是不可判定的 MUST。本脚本把它变成 commit-msg 钩子上的硬门禁。
 *
 * 校验规则：提交信息正文或 footer 中必须同时出现三个键（中英文均可）：
 *   Model:   / 模型:
 *   Trigger: / 触发:
 *   Loop:    / 轮次:
 *
 * 示例（放在 body 末尾）：
 *   Model: Claude-Sonnet-4.5（WorkBuddy Agent）
 *   Trigger: 用户「按规划整改」
 *   Loop: 第二轮审计 → 阶段 C
 *
 * 用法：node scripts/check-commit-trace.mjs <commit-msg-file>
 * 退出码：0 通过；1 缺失（阻止提交）
 */
import { readFileSync } from 'node:fs';

const KEYS = [
  { id: 'Model', re: /^\s*(Model|模型)\s*[:：]\s*\S/im, hint: 'Model: <模型名/版本>' },
  { id: 'Trigger', re: /^\s*(Trigger|触发)\s*[:：]\s*\S/im, hint: 'Trigger: <触发指令摘要>' },
  { id: 'Loop', re: /^\s*(Loop|轮次)\s*[:：]\s*\S/im, hint: 'Loop: <Loop 迭代轮次>' },
];

/** 合并提交（merge）与回滚（revert）由 git 生成，不要求手写追溯信息 */
const SKIP_PREFIXES = [/^Merge /m, /^Revert "/m];

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('[commit-trace] 用法：node scripts/check-commit-trace.mjs <commit-msg-file>');
    process.exit(1);
  }

  const raw = readFileSync(file, 'utf8');
  // 忽略注释行（git 以 # 开头的内容不会进入提交）
  const message = raw
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

  if (SKIP_PREFIXES.some((re) => re.test(message))) {
    console.log('[commit-trace] merge/revert 提交，跳过追溯信息检查');
    return;
  }

  const missing = KEYS.filter((k) => !k.re.test(message));
  if (missing.length === 0) {
    console.log('[commit-trace] ✅ 追溯信息完整');
    return;
  }

  console.error('\n[commit-trace] ❌ 提交信息缺少追溯字段（AGENTS.md §五.5 硬门禁）：\n');
  for (const m of missing) console.error(`  缺失 ${m.id}    →  ${m.hint}`);
  console.error('\n请在提交信息末尾补三行，例如：');
  console.error('  Model: <生成模型/版本>');
  console.error('  Trigger: <触发指令摘要>');
  console.error('  Loop: <Loop 迭代轮次>');
  console.error(
    '\n依据：agents.md §五.5（可追溯性）；如需紧急绕过可用 git commit --no-verify，但须在后续提交补齐说明。\n',
  );
  process.exit(1);
}

main();
