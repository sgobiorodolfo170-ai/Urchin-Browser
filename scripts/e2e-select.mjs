#!/usr/bin/env node
/**
 * E2E 按需选择运行器（本地入口；CI 仍用 `pnpm e2e` 全量）
 *
 * 为什么存在（2026-11-10 / ADR-018）：
 * 全量 E2E 本机 3.4 分钟、38 例、23 个 spec，其中绝大多数与本次改动无关；
 * 每次都全量跑会让「真实的回归信号」淹没在 20 多条无关链路里，也拖慢每次改动。
 *
 * 交互归属（2026-11-10 修订，用户明确要求）：
 * 本脚本**不创建任何软件窗口**。它只负责「按改动算推荐 → 打印清单/JSON →
 * 执行用户明确指定的 spec」。选择交互由 AI 在会话内用自身的复选/问答工具完成
 * （例如 OpenCode 的 question 工具）。项目内只有文档约束，没有 GUI。
 *
 * 规则（docs/E2E用例选择表.md 为完整说明）：
 * - AI 不得默认全量跑：先出推荐表 → 会话内让用户勾选 → 只跑选中的
 * - 全量仅限：发布前 / 选择器无法判定 / 用户明确要求
 * - CI 永远 `pnpm e2e` 全量，且 CI 中绝不出现任何交互
 * - 回退：本方案失效（脚本报错、manifest 漂移、无法判断）时，直接跑 `pnpm e2e`
 *   或 `pnpm e2e:select -- --fallback`，即原本的全量方式
 *
 * 用法：
 *   node scripts/e2e-select.mjs --dry-run        # 打印推荐表（不执行）
 *   node scripts/e2e-select.mjs --dry-run --json # 输出机器可读 JSON（供 AI 组装选择项）
 *   node scripts/e2e-select.mjs --specs=launch.spec.ts,clipper.spec.ts
 *   node scripts/e2e-select.mjs --fallback       # 回退：全量（等价 pnpm e2e）
 *   node scripts/e2e-select.mjs --all            # 同 --fallback
 *   node scripts/e2e-select.mjs --list           # 列出 manifest 全部 23 条
 *   node scripts/e2e-select.mjs --changed=<路径> # 只对指定改动算推荐（可重复/逗号分隔）
 *
 * 退出码：0 通过/仅打印；1 参数或 manifest 错误（按回退方式跑 pnpm e2e）；
 *         3 缺少显式选择（需 AI 会话内确认或显式 --specs/--fallback）；
 *         其它 = Playwright 的退出码（原样透传）。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSpecs, validateManifest } from './lib/e2e-select-core.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e2eDir = join(repoRoot, 'apps', 'desktop', 'tests', 'e2e');
const manifestPath = join(e2eDir, 'manifest.json');
const FALLBACK_COMMAND = 'pnpm e2e';

/* ────────────────────────── 参数 ────────────────────────── */

function parseArgs(argv) {
  const args = {
    all: false,
    fallback: false,
    dryRun: false,
    json: false,
    list: false,
    specs: [],
    changed: [],
  };
  for (const raw of argv) {
    if (raw === '--all') args.all = true;
    else if (raw === '--fallback') args.fallback = true;
    else if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--json') args.json = true;
    else if (raw === '--list') args.list = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--specs=')) {
      args.specs.push(
        ...raw
          .slice('--specs='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (raw.startsWith('--changed=')) {
      args.changed.push(
        ...raw
          .slice('--changed='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else {
      args.error = `未知参数：${raw}`;
    }
  }
  return args;
}

const HELP = `E2E 按需选择运行器（不弹任何软件窗口）

  node scripts/e2e-select.mjs --dry-run             打印推荐表（不执行）
  node scripts/e2e-select.mjs --dry-run --json      输出机器可读推荐（AI 用）
  node scripts/e2e-select.mjs --specs=a.spec.ts,b.spec.ts
  node scripts/e2e-select.mjs --fallback            回退到原全量方式（= pnpm e2e）
  node scripts/e2e-select.mjs --all                 同 --fallback
  node scripts/e2e-select.mjs --list                列出 manifest 全部 23 条
  node scripts/e2e-select.mjs --changed=<路径>      指定改动（可重复/逗号分隔）

流程：AI 先 --dry-run --json 出推荐 → 在会话内用复选/问答工具让用户勾选
      → AI 用 --specs 执行。全量仅限发布前 / 无法判定 / 用户明确要求。
回退：本方案失效时直接执行 \`${FALLBACK_COMMAND}\`（或 --fallback），即原测试方式。
`;

/* ────────────────────────── manifest ────────────────────────── */

function fail(message) {
  console.error(`[e2e-select] ❌ ${message}`);
  console.error(`[e2e-select] 回退方式：执行 \`${FALLBACK_COMMAND}\`（原全量测试方式）`);
  process.exit(1);
}

function loadManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(
      `无法读取 apps/desktop/tests/e2e/manifest.json：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { errors } = validateManifest(manifest, []);
  if (errors.length > 0) {
    fail(`manifest 非法（先跑 pnpm check:e2e-manifest）：\n  ${errors.join('\n  ')}`);
  }
  return manifest.specs;
}

/* ────────────────────────── 改动采集 ────────────────────────── */

function git(args) {
  const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout;
}

/** `git status --porcelain` + 未跟踪 + `git diff --name-only origin/main...HEAD` */
export function collectChangedFiles() {
  const files = new Set();

  const status = git(['status', '--porcelain', '-z']);
  if (status) {
    const parts = status.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const entry = parts[i];
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      // 重命名 / 复制：porcelain -z 的格式是 "R  new\0old"，跳过紧随其后的旧路径
      if (code[0] === 'R' || code[0] === 'C') i += 1;
      if (path) files.add(path);
    }
  }

  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (untracked) for (const line of untracked.split('\n')) if (line.trim()) files.add(line.trim());

  for (const base of ['origin/main', 'origin/develop']) {
    const diff = git(['diff', '--name-only', `${base}...HEAD`]);
    if (diff) {
      for (const line of diff.split('\n')) if (line.trim()) files.add(line.trim());
      break;
    }
  }

  return [...files].sort();
}

/* ────────────────────────── 展示 ────────────────────────── */

/** CJK 字符按 2 列宽计算，保证表格在中文环境下对齐 */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1;
  }
  return width;
}

function pad(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function formatDuration(sec) {
  const total = Math.round(sec);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, '0')}s`;
}

const DEP_LABEL = {
  none: '无',
  'genoffice-artifact': '需 GenOffice 产物（pnpm genoffice:build）',
  'vendor-dsh': '需 vendor/deepseek-harness + 便携 node',
  'api-key': '需 OPENCODE_API_KEY',
};

function printTable(entries, recommendedSpecs) {
  const headers = ['', 'spec', '能力域', '例数', '耗时', '依赖', 'CI', '推荐理由 / 说明'];
  const rows = entries.map((entry) => [
    recommendedSpecs.has(entry.spec) ? '✓' : ' ',
    entry.spec,
    entry.area,
    String(entry.tests),
    formatDuration(entry.durationSec),
    entry.deps === 'none' ? '无' : (DEP_LABEL[entry.deps] ?? entry.deps),
    entry.ciRuns ? '是' : '否',
    (entry.reasons ?? []).join('；') || entry.note,
  ]);
  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i] ?? ''))),
  );
  const line = (row) => row.map((cell, i) => pad(cell ?? '', widths[i] ?? 0)).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

function reportSelection(selection) {
  console.log(`\n[e2e-select] ${selection.note}`);
  if (selection.files.length > 0) {
    const shown = selection.files.slice(0, 8).join('、');
    console.log(
      `[e2e-select] 改动 ${selection.files.length} 个文件：${shown}${selection.files.length > 8 ? ` 等` : ''}`,
    );
  }
  if (selection.recommended.length === 0) {
    console.log('\n（没有需要运行的 spec）');
    return;
  }
  console.log('');
  printTable(selection.recommended, new Set(selection.recommended.map((e) => e.spec)));
  console.log(
    `\n[e2e-select] 推荐集合：${selection.recommended.length} 个 spec / ${selection.recommended.reduce(
      (n, e) => n + e.tests,
      0,
    )} 例，预估 ${formatDuration(selection.totalDurationSec)}`,
  );
}

/** 供 AI 会话组装选择项的稳定 JSON（--dry-run --json） */
function buildJson(selection, entries) {
  const recommended = new Set(selection.recommended.map((entry) => entry.spec));
  return {
    mode: selection.mode,
    note: selection.note,
    files: selection.files,
    totalDurationSec: selection.totalDurationSec,
    totalTests: selection.recommended.reduce((n, e) => n + e.tests, 0),
    recommended: selection.recommended.map((entry) => ({
      ...entry,
      durationLabel: formatDuration(entry.durationSec),
    })),
    all: [...entries]
      .sort((a, b) => a.spec.localeCompare(b.spec))
      .map((entry) => ({
        ...entry,
        recommended: recommended.has(entry.spec),
        durationLabel: formatDuration(entry.durationSec),
      })),
    fallbackCommand: FALLBACK_COMMAND,
  };
}

/* ────────────────────────── 执行 ────────────────────────── */

function runPlaywright(specs, { fallback = false } = {}) {
  if (specs.length === 0) {
    fail('没有选中任何 spec。请用 --specs 指定，或显式 --fallback 全量。');
  }
  const entries = loadManifest();
  const unknown = specs.filter((spec) => !entries.some((entry) => entry.spec === spec));
  if (unknown.length > 0) {
    fail(`manifest 中不存在这些 spec：${unknown.join('、')}（--list 查看全部）`);
  }
  const picked = entries
    .filter((entry) => specs.includes(entry.spec))
    .sort((a, b) => a.spec.localeCompare(b.spec));
  const files = picked.map((entry) => `tests/e2e/${entry.spec}`);
  console.log(
    `\n[e2e-select] ${fallback ? '回退到原全量方式：' : ''}执行 ${picked.length} 个 spec / ` +
      `${picked.reduce((n, e) => n + e.tests, 0)} 例` +
      `（预估 ${formatDuration(picked.reduce((n, e) => n + e.durationSec, 0))}）：\n  ${picked
        .map((entry) => entry.spec)
        .join('\n  ')}\n`,
  );
  const res = spawnSync(
    'pnpm',
    ['--filter', '@urchin/desktop', 'exec', 'playwright', 'test', ...files],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  process.exit(res.status ?? 1);
}

/* ────────────────────────── main ────────────────────────── */

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.error) fail(args.error);

const entries = loadManifest();

if (args.list) {
  console.log(`[e2e-select] manifest 共 ${entries.length} 个 spec：\n`);
  printTable(
    [...entries]
      .sort((a, b) => a.spec.localeCompare(b.spec))
      .map((entry) => ({ ...entry, reasons: [] })),
    new Set(),
  );
  const total = entries.reduce((n, e) => n + e.durationSec, 0);
  console.log(
    `\n[e2e-select] 合计 ${entries.length} 个 spec / ${entries.reduce((n, e) => n + e.tests, 0)} 例，` +
      `全量预估 ${formatDuration(total)}`,
  );
  process.exit(0);
}

const changedFiles = args.changed.length > 0 ? args.changed : collectChangedFiles();
const selection = selectSpecs({ changedFiles, entries });

if (args.all || args.fallback) {
  runPlaywright(
    entries.map((entry) => entry.spec),
    { fallback: args.fallback },
  );
}

if (args.specs.length > 0) {
  runPlaywright(args.specs);
}

if (args.dryRun || args.json) {
  if (args.json) {
    console.log(JSON.stringify(buildJson(selection, entries), null, 2));
  } else {
    console.log('[e2e-select] dry-run（仅打印，不执行）');
    reportSelection(selection);
  }
  process.exit(0);
}

reportSelection(selection);
console.error(
  '\n[e2e-select] ❌ 缺少显式选择：本脚本不弹窗、不静默执行。\n' +
    '  正确流程：AI 把上面的推荐表（或 --dry-run --json 的结果）整理成会话内复选项，\n' +
    '  用户勾选后用 --specs=a.spec.ts,b.spec.ts 执行；全量用 --fallback。\n' +
    `  回退机制：本方案失效时直接执行 \`${FALLBACK_COMMAND}\`（原测试方式）。`,
);
process.exit(3);
