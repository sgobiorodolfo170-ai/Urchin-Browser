/**
 * 记录「verify 已通过」的内容指纹（AGENTS.md §五.6 前置条件 ①）
 *
 * 问题：verify 跑在**工作区**上，而 push 推的是**提交**。若中间改了文件再提交，
 * 「验证过的内容」和「推上去的内容」就不是同一份。仅记录 HEAD sha 也不行——
 * 典型顺序是 verify → commit，commit 后 HEAD 变了，戳立刻失效。
 *
 * 解法：记录**内容树指纹**而不是提交 sha。
 * - 工作区干净时，指纹 = HEAD 的 tree
 * - 工作区有改动时（commit 前的常态），用 `git stash create` 生成一个临时提交，
 *   它的 tree 就是当前工作区内容；该命令**不修改任何状态**（不写 stash 列表）
 * 之后 check-before-push 比对「待推送 HEAD 的 tree」是否等于这个指纹。
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd());
const git = (cmd) => execSync(cmd, { cwd: repoRoot, encoding: 'utf8' }).trim();

function worktreeTree() {
  const dirty = git('git status --porcelain');
  if (dirty) {
    const stashSha = git('git stash create');
    if (stashSha) return git(`git show -s --format=%T ${stashSha}`);
  }
  return git('git show -s --format=%T HEAD');
}

try {
  const tree = worktreeTree();
  const head = git('git rev-parse HEAD');
  const stamp = { tree, head, at: new Date().toISOString() };
  writeFileSync(resolve(repoRoot, '.git/urchin-verify-ok'), JSON.stringify(stamp, null, 2));
  console.log(`[verify-stamp] 已记录内容指纹 ${tree.slice(0, 12)}（HEAD ${head.slice(0, 8)}）`);
} catch (err) {
  // 记录失败不应让 verify 失败——push 时会被 check-before-push 拦下并提示
  console.warn(`[verify-stamp] 记录失败（不影响本次 verify）：${err.message}`);
}
