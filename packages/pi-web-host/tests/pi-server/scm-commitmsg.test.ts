/**
 * scm-commitmsg.ts 单元测试
 *
 * 上游 scm-commitmsg.test.ts 的纯函数用例（提示词拼装 / 输入构造 / 清洗），
 * 追加 generateScmCommitMessage 的端到端分支：真实本地临时 git 仓库 +
 * 假 runtime（严格遵守离线约束，不发起任何网络请求）。
 */
/* eslint-disable @typescript-eslint/require-await -- 移植自上游 pi-web-ui 的 async 桩保持原形状 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMITMSG_SYSTEM_PROMPT,
  MAX_COMMITMSG_LEN,
  buildCommitMsgInput,
  buildCommitMsgPrompt,
  generateScmCommitMessage,
  sanitizeCommitMessage,
} from '../../src/pi-server/scm-commitmsg.js';
import type { ScmCommitContext } from '../../src/pi-server/scm.js';

function ctx(partial: Partial<ScmCommitContext> = {}): ScmCommitContext {
  return {
    subjects: [],
    emptyRepo: true,
    files: [],
    stagedStat: {},
    worktreeStat: {},
    stagedPatch: '',
    worktreePatch: '',
    ...partial,
  };
}

describe('buildCommitMsgInput', () => {
  it('should return null when the working tree is clean', () => {
    expect(buildCommitMsgInput(ctx(), 'zh')).toBeNull();
  });

  it('should still produce input for untracked-only changes (commit-all)', () => {
    const input = buildCommitMsgInput(ctx({ files: [{ path: 'new.txt', x: '?', y: '?' }] }), 'en');
    expect(input).toContain('new.txt');
    expect(input).toContain('Untracked');
  });

  it('should include recent commit subjects as the style reference', () => {
    const input = buildCommitMsgInput(
      ctx({
        subjects: ['feat(scm): 增加面板', 'fix(ui): 对齐'],
        emptyRepo: false,
        worktreePatch: 'diff --git a/x b/x',
      }),
      'en',
    );
    expect(input).toContain('feat(scm): 增加面板');
    expect(input).toContain('fix(ui): 对齐');
    expect(input).not.toContain('no commits yet');
  });

  it('should inject the language instruction for an empty repository', () => {
    const zh = buildCommitMsgInput(ctx({ worktreePatch: 'diff' }), 'zh');
    expect(zh).toContain('请用中文');
    const en = buildCommitMsgInput(ctx({ worktreePatch: 'diff' }), 'en');
    expect(en).toContain('in English');
  });

  it('should include staged and unstaged patches with numstat summaries', () => {
    const input = buildCommitMsgInput(
      ctx({
        stagedPatch: 'diff --git a/a.ts b/a.ts',
        stagedStat: { 'a.ts': [12, 3] },
        worktreePatch: 'diff --git a/b.ts b/b.ts',
        worktreeStat: { 'b.ts': [1, 0] },
      }),
      'en',
    );
    expect(input).toContain('Staged diff');
    expect(input).toContain('+12/-3 a.ts');
    expect(input).toContain('Unstaged diff');
    expect(input).toContain('+1/-0 b.ts');
  });

  it('should truncate the file list at 200 entries and report the remainder', () => {
    const files = Array.from({ length: 205 }, (_, i) => ({ path: `f${i}.ts`, x: 'M', y: ' ' }));
    const input = buildCommitMsgInput(ctx({ files, worktreePatch: 'diff' }), 'en');
    expect(input).toContain('f199.ts');
    expect(input).not.toContain('f200.ts');
    expect(input).toContain('+5 more files');
  });

  it('should not repeat untracked files when a staged patch is present', () => {
    const input = buildCommitMsgInput(
      ctx({
        files: [{ path: 'new.txt', x: '?', y: '?' }],
        stagedPatch: 'diff --git a/new.txt b/new.txt',
      }),
      'en',
    );
    expect(input).not.toContain('Untracked files (new, content not shown)');
  });
});

describe('buildCommitMsgPrompt', () => {
  it('should return the built-in default for append with no custom prompt', () => {
    expect(buildCommitMsgPrompt('append', '')).toBe(COMMITMSG_SYSTEM_PROMPT);
    expect(buildCommitMsgPrompt('append', '   ')).toBe(COMMITMSG_SYSTEM_PROMPT);
  });

  it('should append a custom prompt after the default', () => {
    expect(buildCommitMsgPrompt('append', '总是用祈使句')).toBe(
      `${COMMITMSG_SYSTEM_PROMPT}\n\n总是用祈使句`,
    );
  });

  it('should replace the default with a non-empty custom prompt', () => {
    expect(buildCommitMsgPrompt('replace', '你只输出 conventional commits')).toBe(
      '你只输出 conventional commits',
    );
    expect(buildCommitMsgPrompt('replace', '   ')).toBe(COMMITMSG_SYSTEM_PROMPT);
  });
});

describe('sanitizeCommitMessage', () => {
  it('should keep a normal single line untouched', () => {
    expect(sanitizeCommitMessage('feat(scm): AI 生成提交信息')).toBe('feat(scm): AI 生成提交信息');
  });

  it('should strip code fences and surrounding whitespace', () => {
    expect(sanitizeCommitMessage('```\nfix: bump version\n```')).toBe('fix: bump version');
    expect(sanitizeCommitMessage('```ts\nfix: bump version\n```')).toBe('fix: bump version');
  });

  it('should keep only the first non-empty line', () => {
    expect(sanitizeCommitMessage('fix: one line\n\n详细说明第二行')).toBe('fix: one line');
  });

  it('should strip leading labels in both languages', () => {
    expect(sanitizeCommitMessage('Commit message: fix: x')).toBe('fix: x');
    expect(sanitizeCommitMessage('提交信息：修复 x')).toBe('修复 x');
  });

  it('should strip only matched wrapping quotes', () => {
    expect(sanitizeCommitMessage('"fix: quoted"')).toBe('fix: quoted');
    expect(sanitizeCommitMessage("'fix: single'")).toBe('fix: single');
    expect(sanitizeCommitMessage('fix: ends with "')).toBe('fix: ends with "');
  });

  it('should collapse internal whitespace to single spaces', () => {
    expect(sanitizeCommitMessage('fix:\ttwo  spaces')).toBe('fix: two spaces');
  });

  it('should truncate over-long messages with an ellipsis', () => {
    const long = 'x'.repeat(MAX_COMMITMSG_LEN + 50);
    const out = sanitizeCommitMessage(long);
    expect(out.length).toBe(MAX_COMMITMSG_LEN);
    expect(out.endsWith('…')).toBe(true);
  });

  it('should return an empty string for whitespace-only input', () => {
    expect(sanitizeCommitMessage('  \n\t ')).toBe('');
  });

  it('should keep the system prompt single-line, style-matching and anti-fabrication', () => {
    expect(COMMITMSG_SYSTEM_PROMPT).toContain('single subject line');
    expect(COMMITMSG_SYSTEM_PROMPT).toContain('Match the style');
    expect(COMMITMSG_SYSTEM_PROMPT).toContain('Never invent');
  });
});

/* ------------------------------------------------------------------ */
/* generateScmCommitMessage：真实本地仓库 + 假 runtime                  */
/* ------------------------------------------------------------------ */

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15_000 });
}

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'urchin-commitmsg-'));
  dirs.push(dir);
  gitIn(dir, 'init', '-b', 'main');
  gitIn(dir, 'config', 'user.email', 'test@urchin.local');
  gitIn(dir, 'config', 'user.name', 'Urchin Test');
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 偶发占用，忽略清理失败
    }
  }
});

interface RecordedCall {
  model: unknown;
  context: {
    systemPrompt: string;
    messages: { role: string; content: { type: string; text: string }[] }[];
  };
  options: { maxTokens?: number; signal?: AbortSignal } | undefined;
}

interface FakeRuntime {
  completeSimple: (
    model: unknown,
    context: RecordedCall['context'],
    options?: RecordedCall['options'],
  ) => Promise<{
    stopReason: string;
    errorMessage?: string;
    content: { type: string; text?: string }[];
  }>;
}

function runtimeReturning(text: string, stopReason = 'stop') {
  const calls: RecordedCall[] = [];
  const completeSimple: FakeRuntime['completeSimple'] = (model, context, options) => {
    calls.push({ model, context, options });
    return Promise.resolve({ stopReason, content: [{ type: 'text' as const, text }] });
  };
  return { runtime: { completeSimple: vi.fn(completeSimple) }, calls };
}

describe('generateScmCommitMessage', () => {
  it('should fail fast without calling the model when the tree is clean', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-m', 'init');

    const { runtime, calls } = runtimeReturning('feat: nope');
    const res = await generateScmCommitMessage({ cwd: repo, model: {}, runtime, lang: 'en' });
    expect(res).toEqual({ ok: false, error: 'Nothing to describe (working tree clean)' });
    expect(calls).toHaveLength(0);
  });

  it('should pass the built-in prompt and change material to the model', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const { runtime, calls } = runtimeReturning('feat: add a.txt');
    const res = await generateScmCommitMessage({
      cwd: repo,
      model: { id: 'm' },
      runtime,
      lang: 'en',
    });
    expect(res).toEqual({ ok: true, text: 'feat: add a.txt' });
    expect(calls).toHaveLength(1);
    expect(calls[0].context.systemPrompt).toBe(COMMITMSG_SYSTEM_PROMPT);
    expect(calls[0].context.messages[0].content[0].text).toContain('a.txt');
    expect(calls[0].options?.maxTokens).toBe(400);
  });

  it('should honour replace mode with a custom prompt', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const { runtime, calls } = runtimeReturning('chore: custom');
    await generateScmCommitMessage({
      cwd: repo,
      model: {},
      runtime,
      lang: 'en',
      promptMode: 'replace',
      customPrompt: 'ONLY CONVENTIONAL',
    });
    expect(calls[0].context.systemPrompt).toBe('ONLY CONVENTIONAL');
  });

  it('should append a custom prompt in append mode', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const { runtime, calls } = runtimeReturning('chore: custom');
    await generateScmCommitMessage({
      cwd: repo,
      model: {},
      runtime,
      lang: 'en',
      customPrompt: 'be terse',
    });
    expect(calls[0].context.systemPrompt).toBe(`${COMMITMSG_SYSTEM_PROMPT}\n\nbe terse`);
  });

  it('should sanitize the model output before returning it', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const { runtime } = runtimeReturning('```\nCommit message: fix: cleaned\n```');
    const res = await generateScmCommitMessage({ cwd: repo, model: {}, runtime, lang: 'en' });
    expect(res).toEqual({ ok: true, text: 'fix: cleaned' });
  });

  it('should surface the model error message on abnormal termination', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const runtime = {
      completeSimple: vi.fn(async () => ({
        stopReason: 'error',
        errorMessage: 'provider exploded',
        content: [],
      })),
    };
    const res = await generateScmCommitMessage({ cwd: repo, model: {}, runtime, lang: 'en' });
    expect(res).toEqual({ ok: false, error: 'provider exploded' });
  });

  it('should describe an aborted run without an error message', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const runtime = {
      completeSimple: vi.fn(async () => ({ stopReason: 'aborted', content: [] })),
    };
    const res = await generateScmCommitMessage({ cwd: repo, model: {}, runtime, lang: 'en' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('aborted');
  });

  it('should reject an empty model answer', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const { runtime } = runtimeReturning('   \n  ');
    const res = await generateScmCommitMessage({ cwd: repo, model: {}, runtime, lang: 'en' });
    expect(res).toEqual({ ok: false, error: 'The model returned an empty commit message' });
  });

  it('should report a timeout when the runtime aborts', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const runtime = {
      completeSimple: vi.fn(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            }, 5);
          }),
      ),
    };
    const res = await generateScmCommitMessage({
      cwd: repo,
      model: {},
      runtime,
      lang: 'en',
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('timed out');
  });

  it('should abort the runtime call when the timeout elapses', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    let sawAbort = false;
    const runtime = {
      completeSimple: vi.fn(
        (_model: unknown, _context: unknown, options: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              sawAbort = true;
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    };
    const res = await generateScmCommitMessage({
      cwd: repo,
      model: {},
      runtime,
      lang: 'en',
      timeoutMs: 10,
    });
    expect(sawAbort).toBe(true);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('timed out');
  });

  it('should report a non-repository working directory', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'urchin-commitmsg-plain-'));
    dirs.push(plain);

    const { runtime, calls } = runtimeReturning('feat: nope');
    const res = await generateScmCommitMessage({ cwd: plain, model: {}, runtime, lang: 'en' });
    expect(res).toEqual({ ok: false, error: 'Current directory is not a Git repository' });
    expect(calls).toHaveLength(0);
  });

  it('should return the raw error message for unexpected failures', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const runtime = {
      completeSimple: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const res = await generateScmCommitMessage({ cwd: repo, model: {}, runtime, lang: 'en' });
    expect(res).toEqual({ ok: false, error: 'boom' });
  });

  it('should localize failures for zh callers', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-m', 'init');

    const { runtime } = runtimeReturning('feat: nope');
    const res = await generateScmCommitMessage({ cwd: repo, model: {}, runtime, lang: 'zh' });
    expect(res).toEqual({ ok: false, error: '没有可描述的更改（工作区干净）' });
  });

  it('should ignore non-text content blocks and keep the text ones', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const runtime = {
      completeSimple: vi.fn(async () => ({
        stopReason: 'stop',
        content: [{ type: 'image' }, { type: 'text', text: 'fix: from text' }],
      })),
    };
    const res = await generateScmCommitMessage({ cwd: repo, model: {}, runtime, lang: 'en' });
    expect(res).toEqual({ ok: true, text: 'fix: from text' });
  });

  it('should stringify non-Error rejections', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'x\n');

    const runtime = {
      // 故意用非 Error 拒绝值验证 `String(err)` 兜底分支
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      completeSimple: vi.fn(() => Promise.reject('boom')),
    };
    const res = await generateScmCommitMessage({ cwd: repo, model: {}, runtime, lang: 'en' });
    expect(res).toEqual({ ok: false, error: 'boom' });
  });
});

describe('sanitize edge cases', () => {
  it('should strip backtick-wrapped messages', () => {
    expect(sanitizeCommitMessage('`fix: backtick`')).toBe('fix: backtick');
  });

  it('should keep a single-character message untouched (no quote stripping possible)', () => {
    expect(sanitizeCommitMessage('x')).toBe('x');
  });
});
