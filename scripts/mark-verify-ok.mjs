/**
 * 记录「verify 已通过」的内容指纹（AGENTS.md §五.6 前置条件 ①）
 *
 * 问题：verify 跑在**工作区**上，而 push 推的是**提交**。若中间改了文件再提交，
 * 「验证过的内容」和「推上去的内容」就不是同一份。仅记录 HEAD sha 也不行——
 * 典型顺序是 verify → commit，commit 后 HEAD 变了，戳立刻失效。
 *
 * 解法：记录**内容树指纹**而不是提交 sha。
 * - 工作区干净时，指纹 = HEAD 的 tree
 * - 工作区有改动时（commit 前的常态），在**临时索引**（GIT_INDEX_FILE，不动真实
 *   index、不写 stash 列表、不修改任何工作区状态）里重演「read-tree HEAD → add -A →
 *   write-tree」，得到当前工作区内容的树：
 *   - untracked 文件**编入指纹**（排除 .gitignore 命中项，与 `git status --porcelain`
 *     口径一致）——dev.161 现场：新文档 untracked 时 verify 通过、提交后 HEAD 树含
 *     该文件而指纹不含，G16 拦下 push、被迫重跑全量 verify（dev.162 盲点实证）；
 *     旧实现用 `git stash create` 取树，stash 恰好不收 untracked，正是漏洞所在。
 *   - add -A 与随后真实 commit 走同一套 clean 过滤 / CRLF 配置，
 *     「verify → commit」之后两棵树必然一致，G16 不再误拦。
 *
 * 之后 check-before-push 比对「待推送 HEAD 的 tree」是否等于这个指纹。
 */
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = resolve(process.cwd());
// maxBuffer 必须远大于默认 1MB：vendor 整树移出仓库这类批次会产生 1.6 万行
// git status --porcelain 输出（>1MB），不加大缓冲会在生成内容指纹时 ENOBUFS（P2-13 实测触发）
const GIT_OPTS = {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
};

function worktreeTree() {
  const dirty = execSync('git status --porcelain', GIT_OPTS).toString();
  if (!dirty) return execSync('git show -s --format=%T HEAD', GIT_OPTS).toString().trim();
  // 临时索引：与真实 index 隔离（GIT_INDEX_FILE 只作用于本进程 inline env，不外泄）。
  // - 放 os.tmpdir() 而非 .git：文件名带 pid 唯一，避免与并发 verify 或上次中断残留的
  //   `.lock` 相互撞锁（曾在 .git 下共享同名 → 中断后遗留 lock 硬失败）；
  // - read-tree HEAD 做底 → add -A 只对改动/untracked 文件重新散列，实测 ~4s 不整仓重算
  const tmpIndex = join(tmpdir(), `urchin-fingerprint-${process.pid}-${Date.now() % 100000}-index`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const gitOpts = { ...GIT_OPTS, env, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    execSync('git read-tree HEAD', gitOpts);
    execSync('git add -A', gitOpts);
    return execSync('git write-tree', gitOpts).toString().trim();
  } finally {
    // 临时索引与其 .lock 兄弟文件清理失败只会留下垃圾文件，不影响指纹与判定
    try {
      rmSync(tmpIndex, { force: true });
      rmSync(`${tmpIndex}.lock`, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

function main() {
  try {
    const tree = worktreeTree();
    const head = execSync('git rev-parse HEAD', GIT_OPTS).toString().trim();
    const stamp = { tree, head, at: new Date().toISOString() };
    writeFileSync(resolve(repoRoot, '.git', 'urchin-verify-ok'), JSON.stringify(stamp, null, 2));
    console.log(`[verify-stamp] 已记录内容指纹 ${tree.slice(0, 12)}（HEAD ${head.slice(0, 8)}）`);
  } catch (err) {
    // 记录失败不应让 verify 失败——push 时会被 check-before-push 拦下并提示
    console.warn(
      `[verify-stamp] 记录失败（不影响本次 verify）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

main();
