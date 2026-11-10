/**
 * E2E 按需选择核心逻辑单测（scripts/lib/e2e-select-core.mjs）
 *
 * 覆盖本机制唯一需要「判断」的部分：改动路径 → 推荐 spec、文档改动 → 0 条、
 * 无命中 → 全量、manifest 双向一致性。弹窗与子进程属 IO，由人工验收与
 * `--dry-run` 覆盖（见 docs/E2E用例选择表.md）。
 *
 * 测试方式：直接 import 真实 core 模块 + 读真实 manifest / spec 目录，
 * 不 mock——目标就是防止「选择器与真实 manifest 脱节」。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// tests/unit/scripts → unit → tests → desktop → apps → 仓库根（5 层）
const REPO_ROOT = resolve(here, '..', '..', '..', '..', '..');
const CORE = join(REPO_ROOT, 'scripts', 'lib', 'e2e-select-core.mjs');
const E2E_DIR = join(REPO_ROOT, 'apps', 'desktop', 'tests', 'e2e');
const MANIFEST = join(E2E_DIR, 'manifest.json');

// core 是 .mjs（无类型声明）：按路径动态 import 后显式断言为本文件的接口。
// 不能用 any——ESLint 的 no-unsafe-* 规则在测试里仍然生效（只放宽了 no-explicit-any）。
interface Entry {
  spec: string;
  area: string;
  tests: number;
  durationSec: number;
  triggers: string[];
  deps: string;
  ciRuns: boolean;
  alwaysRecommend: boolean;
  note: string;
}

interface RecommendedEntry extends Entry {
  reasons: string[];
}

interface Selection {
  mode: 'matched' | 'doc-only' | 'no-match' | 'unknown';
  files: string[];
  recommended: RecommendedEntry[];
  totalDurationSec: number;
  note: string;
}

interface ManifestCheck {
  errors: string[];
  count: number;
}

interface E2ECore {
  matchesTriggers(file: string, triggers: string[]): boolean;
  selectSpecs(input: { changedFiles: string[]; entries: Entry[] }): Selection;
  validateManifest(manifest: unknown, specFiles: string[]): ManifestCheck;
}

let core: E2ECore;

function readManifest(): { specs: Entry[] } {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as { specs: Entry[] };
}

function specFiles(): string[] {
  return readdirSync(E2E_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort();
}

beforeAll(async () => {
  core = (await import(pathToFileURL(CORE).href)) as E2ECore;
});

describe('e2e-select-core · 路径匹配', () => {
  it('should match ** across directories and * within one level', () => {
    expect(
      core.matchesTriggers('apps/desktop/src/main/tabs/tab-manager.ts', [
        'apps/desktop/src/main/tabs/**',
      ]),
    ).toBe(true);
    expect(
      core.matchesTriggers('apps/desktop/src/main/tabs/deep/x.ts', [
        'apps/desktop/src/main/tabs/**',
      ]),
    ).toBe(true);
    expect(
      core.matchesTriggers('apps/desktop/src/main/other/x.ts', ['apps/desktop/src/main/tabs/**']),
    ).toBe(false);
    expect(
      core.matchesTriggers('apps/desktop/src/main/tabs/a/b.ts', [
        'apps/desktop/src/main/tabs/*.ts',
      ]),
    ).toBe(false);
    expect(
      core.matchesTriggers('apps/desktop/src/main/tabs/a.ts', ['apps/desktop/src/main/tabs/*.ts']),
    ).toBe(true);
    // 反斜杠路径按 POSIX 归一化后同样命中（Windows git 输出）
    expect(
      core.matchesTriggers('apps\\desktop\\src\\main\\tabs\\x.ts', [
        'apps/desktop/src/main/tabs/**',
      ]),
    ).toBe(true);
  });

  it('should treat regex metacharacters as literals', () => {
    expect(core.matchesTriggers('a/b.ts', ['a/b.ts'])).toBe(true);
    expect(core.matchesTriggers('aXbYts', ['a/b.ts'])).toBe(false);
  });
});

describe('e2e-select-core · 推荐策略', () => {
  it('should recommend nothing for docs-only changes', () => {
    const selection = core.selectSpecs({
      changedFiles: ['docs/E2E用例选择表.md', 'README.md'],
      entries: readManifest().specs,
    });
    expect(selection.mode).toBe('doc-only');
    expect(selection.recommended).toHaveLength(0);
    expect(selection.note).toContain('文档改动无需 E2E');
  });

  it('should recommend launch + tab specs for tab-manager changes', () => {
    const selection = core.selectSpecs({
      changedFiles: ['apps/desktop/src/main/tabs/tab-manager.ts'],
      entries: readManifest().specs,
    });
    expect(selection.mode).toBe('matched');
    const specs = selection.recommended.map((entry: Entry) => entry.spec);
    expect(specs).toContain('launch.spec.ts');
    expect(specs).toContain('tab-order-repro.spec.ts');
    expect(specs).toContain('tab-close-activation.spec.ts');
    // alwaysRecommend 基线始终并入推荐集合
    const launch = selection.recommended.find((entry: Entry) => entry.spec === 'launch.spec.ts');
    expect(launch?.reasons.join('')).toContain('基线');
    expect(selection.totalDurationSec).toBeGreaterThan(0);
  });

  it('should fall back to full suite when nothing matches', () => {
    const entries = readManifest().specs;
    const selection = core.selectSpecs({
      changedFiles: ['apps/desktop/src/main/unknown-area/file.ts'],
      entries,
    });
    expect(selection.mode).toBe('no-match');
    expect(selection.recommended).toHaveLength(entries.length);
    expect(selection.note).toContain('全量');
  });

  it('should fall back to full suite when changes are unknown', () => {
    const entries = readManifest().specs;
    const selection = core.selectSpecs({ changedFiles: [], entries });
    expect(selection.mode).toBe('unknown');
    expect(selection.recommended).toHaveLength(entries.length);
    expect(selection.note).toContain('全量');
  });
});

describe('e2e-select-core · manifest 校验', () => {
  it('should accept the real manifest and cover every spec file', () => {
    const { errors, count } = core.validateManifest(readManifest(), specFiles());
    expect(errors).toEqual([]);
    expect(count).toBe(specFiles().length);
    expect(count).toBe(23);
  });

  it('should fail on missing entries, orphan entries and illegal fields', () => {
    const base = readManifest().specs;
    const missing = base.filter((entry) => entry.spec !== 'launch.spec.ts');
    expect(core.validateManifest({ specs: missing }, specFiles()).errors.join('\n')).toContain(
      '缺少 manifest 条目：launch.spec.ts',
    );

    const orphan = [...base, { ...base[0]!, spec: 'not-exist.spec.ts' }];
    expect(core.validateManifest({ specs: orphan }, specFiles()).errors.join('\n')).toContain(
      '孤儿条目',
    );

    const illegal = base.map((entry, index) =>
      index === 0 ? { ...entry, deps: 'unknown-dep', tests: 0, triggers: [] } : entry,
    );
    const errors = core.validateManifest({ specs: illegal }, specFiles()).errors.join('\n');
    expect(errors).toContain('.deps 必须是');
    expect(errors).toContain('.tests 必须是正整数');
    expect(errors).toContain('.triggers 必须是非空');
  });

  it('should reject a malformed top-level manifest', () => {
    expect(core.validateManifest({}, specFiles()).errors[0]).toContain('specs');
  });
});
