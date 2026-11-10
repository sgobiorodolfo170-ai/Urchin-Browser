/**
 * e2e-select CLI 测试（scripts/e2e-select.mjs）
 *
 * 重点验证「交互归属 AI 会话」后的新契约：
 * - `--dry-run --json` 输出可被 AI 直接映射成选择项的 JSON；
 * - 不弹任何软件窗口（脚本内已无 PowerShell/WinForms 代码）；
 * - 无显式选择时只打印并以退出码 3 结束（不静默执行、不静默全量）；
 * - `--fallback` / `--all` 是回退到原全量方式的入口；
 * - 未知 spec 走失败 + 回退提示，不误跑。
 *
 * 测试方式：真实子进程执行，不 mock——确保 agent 拿到的就是实际 CLI 行为。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// tests/unit/scripts → unit → tests → desktop → apps → 仓库根（5 层）
const REPO_ROOT = resolve(here, '..', '..', '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'e2e-select.mjs');

interface RecommendedEntry {
  spec: string;
  reasons: string[];
  tests: number;
}

interface DryRunJson {
  mode: string;
  note: string;
  files: string[];
  totalDurationSec: number;
  totalTests: number;
  recommended: RecommendedEntry[];
  all: { spec: string; durationLabel: string; recommended: boolean }[];
  fallbackCommand: string;
}

function run(args: string[]) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('e2e-select CLI · 会话内选择契约', () => {
  it('should output machine-readable JSON for AI with --dry-run --json', () => {
    const { status, stdout } = run([
      '--dry-run',
      '--json',
      '--changed=apps/desktop/src/main/tabs/tab-manager.ts',
    ]);
    expect(status).toBe(0);
    const data = JSON.parse(stdout) as DryRunJson;
    expect(data.mode).toBe('matched');
    expect(data.recommended.map((entry: RecommendedEntry) => entry.spec)).toContain(
      'launch.spec.ts',
    );
    expect(data.all).toHaveLength(23);
    expect(
      data.recommended.every(
        (entry: RecommendedEntry) => Array.isArray(entry.reasons) && entry.reasons.length > 0,
      ),
    ).toBe(true);
    expect(data.fallbackCommand).toBe('pnpm e2e');
  });

  it('should print the docs-only recommendation without running anything', () => {
    const { status, stdout } = run(['--dry-run', '--json', '--changed=docs/E2E用例选择表.md']);
    expect(status).toBe(0);
    const data = JSON.parse(stdout) as DryRunJson;
    expect(data.mode).toBe('doc-only');
    expect(data.recommended).toHaveLength(0);
    expect(data.note).toContain('文档改动无需 E2E');
  });

  it('should refuse to guess when no explicit selection is given (exit 3, no window)', () => {
    const { status, stdout, stderr } = run(['--changed=apps/desktop/src/main/tabs/tab-manager.ts']);
    expect(status).toBe(3);
    expect(stdout).toContain('launch.spec.ts');
    expect(stderr).toContain('本脚本不弹窗');
    expect(stderr).toContain('pnpm e2e');
  });

  it('should list all 23 specs', () => {
    const { status, stdout } = run(['--list']);
    expect(status).toBe(0);
    expect(stdout.split(/\r?\n/).filter((line) => line.includes('.spec.ts'))).toHaveLength(23);
  });

  it('should fail unknown specs and point to the fallback command', () => {
    const { status, stderr } = run(['--specs=not-exist.spec.ts']);
    expect(status).toBe(1);
    expect(stderr).toContain('not-exist.spec.ts');
    expect(stderr).toContain('pnpm e2e');
  });
});
