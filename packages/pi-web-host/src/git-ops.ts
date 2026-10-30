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
  detached?: boolean;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
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
    let detached = false;
    try {
      const { stdout: branchOut } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd,
        timeout: 5000,
      });
      branch = branchOut.trim();
      if (!branch) {
        detached = true;
        try {
          const { stdout: headOut } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd,
            timeout: 5000,
          });
          branch = headOut.trim();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* detached HEAD 等情况 */
    }

    // 1b. 上游分支 + ahead/behind
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    if (!detached) {
      try {
        const { stdout: upOut } = await execFileAsync(
          'git',
          ['rev-parse', '--abbrev-ref', '@{upstream}'],
          { cwd, timeout: 5000 },
        );
        upstream = upOut.trim() || null;
        if (upstream) {
          try {
            const { stdout: aheadOut } = await execFileAsync(
              'git',
              ['rev-list', '--count', '@{upstream}..HEAD'],
              { cwd, timeout: 5000 },
            );
            ahead = parseInt(aheadOut.trim(), 10) || 0;
          } catch {
            /* ignore */
          }
          try {
            const { stdout: behindOut } = await execFileAsync(
              'git',
              ['rev-list', '--count', 'HEAD..@{upstream}'],
              { cwd, timeout: 5000 },
            );
            behind = parseInt(behindOut.trim(), 10) || 0;
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* no upstream */
      }
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

    return { ok: true, branch, detached, upstream, ahead, behind, files, branches };
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

interface ScmCommitEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  decorations: string;
  graph: string;
}

export interface GitHistoryResult {
  ok: boolean;
  error?: string;
  history?: ScmCommitEntry[];
}

/** 获取提交历史（scm_history 的后端实现） */
export async function getGitHistory(cwd: string): Promise<GitHistoryResult> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--graph', '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D', '--date=short', '-50'],
      { cwd, timeout: 8000 },
    );
    const history: ScmCommitEntry[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      // graph 前缀在 \x1f 之前
      const tabIdx = line.indexOf('\x1f');
      if (tabIdx < 0) continue;
      const graph = line.slice(0, tabIdx);
      const [hash, shortHash, author, date, subject, decorations] = line
        .slice(tabIdx + 1)
        .split('\x1f');
      history.push({
        hash: hash ?? '',
        shortHash: shortHash ?? '',
        author: author ?? '',
        date: date ?? '',
        subject: subject ?? '',
        decorations: decorations ?? '',
        graph,
      });
    }
    return { ok: true, history };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface GitFileDiffResult {
  ok: boolean;
  error?: string;
  stagedText?: string;
  worktreeText?: string;
  untracked?: boolean;
}

/** 获取文件 diff（scm_filediff 的后端实现） */
export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResult> {
  try {
    let stagedText = '';
    let worktreeText = '';
    let untracked = false;
    // 检查是否 untracked
    try {
      const { stdout: lsOut } = await execFileAsync(
        'git',
        ['ls-files', '--error-unmatch', filePath],
        { cwd, timeout: 5000 },
      );
      if (!lsOut.trim()) untracked = true;
    } catch {
      untracked = true;
    }
    if (!untracked) {
      try {
        const { stdout } = await execFileAsync('git', ['diff', '--staged', filePath], {
          cwd,
          timeout: 5000,
        });
        stagedText = stdout;
      } catch {
        /* ignore */
      }
      try {
        const { stdout } = await execFileAsync('git', ['diff', filePath], {
          cwd,
          timeout: 5000,
        });
        worktreeText = stdout;
      } catch {
        /* ignore */
      }
    }
    return { ok: true, stagedText, worktreeText, untracked };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface GitCommitDetailResult {
  ok: boolean;
  error?: string;
  stagedText?: string;
}

/** 获取某个 commit 的完整 patch（scm_commit 的后端实现） */
export async function getGitCommitDetail(
  cwd: string,
  hash: string,
): Promise<GitCommitDetailResult> {
  try {
    const { stdout } = await execFileAsync('git', ['show', hash], {
      cwd,
      timeout: 5000,
    });
    return { ok: true, stagedText: stdout };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
