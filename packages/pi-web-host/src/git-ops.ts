/**
 * pi-web-host · Git 操作（第三批 3-2）
 *
 * utility 进程内通过 child_process 调 git CLI，为前端 SCM 面板提供数据。
 * 返回 protocol.ts 的 scm_data 格式（kind: 'status'）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ScmFileEntry {
  path: string;
  x: string;
  y: string;
}

interface ScmBranchEntry {
  name: string;
  current: boolean;
  remote?: string | boolean;
}

export interface GitStatusResult {
  ok: boolean;
  error?: string;
  notRepo?: boolean;
  branch?: string;
  files?: ScmFileEntry[];
  branches?: ScmBranchEntry[];
}

/**
 * 获取 git 状态（scm_status 的后端实现）。
 *
 * @param cwd 工作目录（git 仓库根）
 */
export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  try {
    // 1. 当前分支
    let branch = '';
    try {
      const { stdout: branchOut } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd,
        timeout: 5000,
      });
      branch = branchOut.trim();
    } catch {
      /* detached HEAD 等情况 */
    }

    // 2. 文件状态（porcelain v1）
    const files: ScmFileEntry[] = [];
    try {
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd,
        timeout: 5000,
      });
      for (const line of statusOut.split('\n')) {
        if (!line) continue;
        // "XY path" — X=index, Y=worktree（各 1 字符）
        const x = line[0] ?? ' ';
        const y = line[1] ?? ' ';
        const path = line.slice(3).trim();
        if (path) files.push({ path, x, y });
      }
    } catch {
      /* ignore */
    }

    // 3. 分支列表
    const branches: ScmBranchEntry[] = [];
    try {
      const { stdout: branchListOut } = await execFileAsync('git', ['branch', '--list'], {
        cwd,
        timeout: 5000,
      });
      for (const line of branchListOut.split('\n')) {
        const current = line.startsWith('*');
        const name = line.replace(/^\*?\s+/, '').trim();
        if (name) branches.push({ name, current });
      }
    } catch {
      /* ignore */
    }

    return { ok: true, branch, files, branches };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    if (
      err.stderr?.includes('not a git repository') ||
      err.message?.includes('not a git repository')
    ) {
      return { ok: true, notRepo: true, files: [], branches: [] };
    }
    return { ok: false, error: err.message ?? String(e) };
  }
}
