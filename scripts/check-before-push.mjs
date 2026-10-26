/**
 * 推送前置检查（AGENTS.md §五.6 / 硬门禁 G16）
 *
 * 由 .husky/pre-push 调用。把 §五.6 的 5 条前置条件里**可机器判定**的 3 条做成硬门禁：
 *   ① 内容已通过 verify（比对内容树指纹，见 scripts/mark-verify-ok.mjs）
 *   ② 本地未落后远端（落后即分叉，禁止自动 rebase/merge，直接停）
 *   ③ 工作区干净（不允许把未提交状态混进推送批次）
 *
 * 不可机器判定的两条（禁止 force、失败即停并上报）靠流程约定 + 本条 ② 间接兜住：
 * 落后时 push 必然非 fast-forward，② 会先拦住，force 也就没有触发场景。
 *
 * 用法：node scripts/check-before-push.mjs（pre-push 钩子自动调用）
 * 退出码：0 放行；1 拦截
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd());
const git = (cmd, opts = {}) =>
  execSync(cmd, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();

const problems = [];
const notes = [];

function checkUpstream() {
  let upstream;
  try {
    upstream = git('git rev-parse --abbrev-ref --symbolic-full-name @{u}');
  } catch {
    notes.push('当前分支无上游跟踪，跳过落后检查（首次推送时属正常）');
    return;
  }
  try {
    git('git fetch origin --quiet');
  } catch {
    notes.push('git fetch 失败（离线或权限问题），落后检查可能不准');
  }
  try {
    const [behind, ahead] = git(`git rev-list --left-right --count ${upstream}...HEAD`)
      .split(/\s+/)
      .map(Number);
    if (behind > 0) {
      problems.push(
        `本地落后 ${upstream} ${behind} 个提交：分叉状态下禁止推送。请先人工同步（不自动 rebase/merge）。`,
      );
    }
    if (ahead === 0) notes.push('本地无待推送提交');
  } catch {
    notes.push('无法计算 ahead/behind，跳过该检查');
  }
}

function checkWorktree() {
  const dirty = git('git status --porcelain');
  if (dirty) {
    const lines = dirty.split('\n').slice(0, 5).join('\n  ');
    problems.push(`工作区有未提交改动，先提交或还原再推送：\n  ${lines}`);
  }
}

function checkVerifyStamp() {
  const stampPath = resolve(repoRoot, '.git/urchin-verify-ok');
  if (!existsSync(stampPath)) {
    problems.push('未找到 verify 通过记录：推送前请先运行 `pnpm verify`');
    return;
  }
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
  } catch {
    problems.push('verify 记录无法解析：请重新运行 `pnpm verify`');
    return;
  }
  const headTree = git('git show -s --format=%T HEAD');
  if (stamp.tree !== headTree) {
    problems.push(
      `待推送内容未通过 verify：记录指纹 ${String(stamp.tree).slice(0, 12)}，当前 HEAD 树 ${headTree.slice(0, 12)}。请重新运行 \`pnpm verify\`。`,
    );
  }
}

checkWorktree();
checkVerifyStamp();
checkUpstream();

if (problems.length === 0) {
  for (const n of notes) console.log(`[pre-push] ${n}`);
  console.log('[pre-push] ✅ 推送前置检查通过');
  process.exit(0);
}

console.error('\n[pre-push] ❌ 推送被拦截（AGENTS.md §五.6）：\n');
for (const p of problems) console.error(`  - ${p}`);
console.error('\n依据：push 属可逆但对外可见操作，必须满足「内容已验证 + 无分叉 + 工作区干净」。');
console.error('确需绕过时用 `git push --no-verify`，并在提交说明中注明原因。\n');
process.exit(1);
