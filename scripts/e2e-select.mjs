#!/usr/bin/env node
/**
 * E2E 按需选择运行器（本地默认入口，CI 仍用 `pnpm e2e` 全量）
 *
 * 为什么存在（2026-11-10 / ADR-018）：
 * 全量 E2E 本机 3.4 分钟、38 例、23 个 spec，其中绝大多数与本次改动无关；
 * 每次都全量跑会让「真实的回归信号」淹没在 20 多条无关链路里，也拖慢每次改动。
 * 因此本地改为：先按改动路径出推荐表 → 弹出复选清单 → 用户勾选 → 只跑选中的。
 *
 * 规则（docs/E2E用例选择表.md 为完整说明）：
 * - AI 不得默认全量跑；必须先出表 → 给建议 → 用户勾选
 * - 全量仅限：发布前 / 选择器无法判定 / 用户明确要求
 * - CI 永远 `pnpm e2e` 全量，且 CI 中绝不弹窗
 *
 * 用法：
 *   node scripts/e2e-select.mjs                    # 采集改动 → 弹窗勾选 → 运行
 *   node scripts/e2e-select.mjs --all              # 全量（等价 pnpm e2e）
 *   node scripts/e2e-select.mjs --specs=launch.spec.ts,clipper.spec.ts
 *   node scripts/e2e-select.mjs --dry-run          # 只打印推荐表，不运行
 *   node scripts/e2e-select.mjs --dry-run --changed=apps/desktop/src/main/tabs/tab-manager.ts
 *   node scripts/e2e-select.mjs --list             # 列出 manifest 全部条目
 *   node scripts/e2e-select.mjs --interactive      # 强制弹窗（无 TTY 时用于人工验收）
 *
 * 退出码：0 通过；1 参数/manifest 错误；2 用户取消或未选；3 非交互环境缺少显式选择；
 *         其它 = Playwright 的退出码（原样透传）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSpecs, validateManifest } from './lib/e2e-select-core.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e2eDir = join(repoRoot, 'apps', 'desktop', 'tests', 'e2e');
const manifestPath = join(e2eDir, 'manifest.json');

/* ────────────────────────── 参数 ────────────────────────── */

function parseArgs(argv) {
  const args = {
    all: false,
    dryRun: false,
    list: false,
    interactive: false,
    specs: [],
    changed: [],
  };
  for (const raw of argv) {
    if (raw === '--all') args.all = true;
    else if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--list') args.list = true;
    else if (raw === '--interactive') args.interactive = true;
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

const HELP = `E2E 按需选择运行器

  node scripts/e2e-select.mjs                      按改动推荐 → 弹窗勾选 → 运行
  node scripts/e2e-select.mjs --dry-run            只打印推荐表（可加 --changed=<路径>）
  node scripts/e2e-select.mjs --all                全量运行（发布前 / 明确要求）
  node scripts/e2e-select.mjs --specs=a.spec.ts,b.spec.ts
  node scripts/e2e-select.mjs --list               列出 manifest 全部 23 条
  node scripts/e2e-select.mjs --interactive        强制弹窗（无 TTY 时人工验收用）

规则：本地按需、CI 全量；选择器无法判定时建议全量并说明原因。
`;

/* ────────────────────────── manifest ────────────────────────── */

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

function fail(message) {
  console.error(`[e2e-select] ❌ ${message}`);
  process.exit(1);
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

/* ────────────────────────── 弹窗（PowerShell WinForms） ────────────────────────── */

/** UTF-8 BOM：PowerShell 5.1 无 BOM 时按 ANSI 解码，中文必乱码（实测） */
function writePs1Utf8Bom(path, content) {
  writeFileSync(path, `\ufeff${content}`, 'utf8');
}

const DIALOG_PS1 = String.raw`
param([string]$InputFile, [string]$OutputFile)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$data = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
$specs = @($data.specs)

$form = New-Object System.Windows.Forms.Form
$form.Text = '顽童浏览器 · 选择要运行的 E2E 用例'
$form.Size = New-Object System.Drawing.Size(1040, 680)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$header = New-Object System.Windows.Forms.Label
$header.Location = New-Object System.Drawing.Point(16, 12)
$header.Size = New-Object System.Drawing.Size(1000, 52)
$header.Text = $data.header
$form.Controls.Add($header)

$list = New-Object System.Windows.Forms.CheckedListBox
$list.Location = New-Object System.Drawing.Point(16, 68)
$list.Size = New-Object System.Drawing.Size(1000, 480)
$list.CheckOnClick = $true
$list.HorizontalScrollbar = $true
$list.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.Controls.Add($list)

$specs | ForEach-Object {
  $box = if ($_.recommended) { '[x]' } else { '[ ]' }
  $index = $list.Items.Add(('{0} {1} — {2} — {3} 例 — {4} — {5}' -f $box, $_.spec, $_.area, $_.tests, $_.duration, $_.reason))
  $list.SetItemChecked($index, [bool]$_.recommended)
}

$panel = New-Object System.Windows.Forms.FlowLayoutPanel
$panel.Location = New-Object System.Drawing.Point(16, 560)
$panel.Size = New-Object System.Drawing.Size(1000, 70)
$panel.FlowDirection = 'LeftToRight'
$form.Controls.Add($panel)

function Write-Result([string]$action) {
  $picked = @()
  for ($i = 0; $i -lt $specs.Count; $i++) {
    if ($list.GetItemChecked($i)) { $picked += $specs[$i].spec }
  }
  $payload = [pscustomobject]@{ action = $action; specs = $picked }
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputFile -Encoding UTF8
  $form.Close()
}

$btnRecommend = New-Object System.Windows.Forms.Button
$btnRecommend.Text = '仅推荐'
$btnRecommend.Size = New-Object System.Drawing.Size(96, 34)
$btnRecommend.Add_Click({
  for ($i = 0; $i -lt $specs.Count; $i++) { $list.SetItemChecked($i, [bool]$specs[$i].recommended) }
})
$panel.Controls.Add($btnRecommend)

$btnAll = New-Object System.Windows.Forms.Button
$btnAll.Text = '全选'
$btnAll.Size = New-Object System.Drawing.Size(96, 34)
$btnAll.Add_Click({ for ($i = 0; $i -lt $specs.Count; $i++) { $list.SetItemChecked($i, $true) } })
$panel.Controls.Add($btnAll)

$btnNone = New-Object System.Windows.Forms.Button
$btnNone.Text = '全不选'
$btnNone.Size = New-Object System.Drawing.Size(96, 34)
$btnNone.Add_Click({ for ($i = 0; $i -lt $specs.Count; $i++) { $list.SetItemChecked($i, $false) } })
$panel.Controls.Add($btnNone)

$btnRun = New-Object System.Windows.Forms.Button
$btnRun.Text = '运行所选'
$btnRun.Size = New-Object System.Drawing.Size(140, 34)
$btnRun.Add_Click({ Write-Result 'run' })
$panel.Controls.Add($btnRun)

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = '取消'
$btnCancel.Size = New-Object System.Drawing.Size(96, 34)
$btnCancel.Add_Click({ Write-Result 'cancel' })
$panel.Controls.Add($btnCancel)

$form.Add_Shown({
  # 句柄创建后再落一次勾选：CheckedListBox 在句柄创建前 SetItemChecked 在部分
  # Windows/WinForms 组合下会被重置（2026-11-10 实测：弹窗默认全不选 → 空选择退出）。
  for ($i = 0; $i -lt $specs.Count; $i++) {
    $list.SetItemChecked($i, [bool]$specs[$i].recommended)
  }
  $form.Activate()
})
$form.ShowDialog() | Out-Null

if (-not (Test-Path -LiteralPath $OutputFile)) {
  [pscustomobject]@{ action = 'cancel'; specs = @() } | ConvertTo-Json | Set-Content -LiteralPath $OutputFile -Encoding UTF8
}
`;

function hasCommand(command) {
  const res = spawnSync('where', [command], { encoding: 'utf8' });
  return res.status === 0;
}

/** 返回 { action, specs }；弹窗不可用 / 用户取消时抛出带 code 的错误 */
function showDialog(selection) {
  const dir = mkdtempSync(join(tmpdir(), 'urchin-e2e-select-'));
  const inputPath = join(dir, 'input.json');
  const outputPath = join(dir, 'result.json');
  const scriptPath = join(dir, 'dialog.ps1');

  const allSpecs = loadManifest().sort((a, b) => a.spec.localeCompare(b.spec));
  const recommended = new Set(selection.recommended.map((entry) => entry.spec));
  const payload = {
    header:
      `推荐 ${selection.recommended.length} 个 spec / ` +
      `${selection.recommended.reduce((n, e) => n + e.tests, 0)} 例，` +
      `预估 ${formatDuration(selection.totalDurationSec)}。\n` +
      `${selection.note}\n` +
      '勾选后点「运行所选」；全量仅建议在发布前或选择器无法判定时使用。',
    specs: allSpecs.map((entry) => {
      const item = {
        spec: entry.spec,
        area: entry.area,
        tests: entry.tests,
        duration: formatDuration(entry.durationSec),
        recommended: recommended.has(entry.spec),
        reason: entry.note,
      };
      const matched = selection.recommended.find((e) => e.spec === entry.spec);
      if (matched) item.reason = matched.reasons.join('；');
      return item;
    }),
  };
  writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8');
  writePs1Utf8Bom(scriptPath, DIALOG_PS1);

  const shell = hasCommand('pwsh') ? 'pwsh.exe' : 'powershell.exe';
  try {
    const res = spawnSync(
      shell,
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        inputPath,
        outputPath,
      ],
      { stdio: 'inherit' },
    );
    if (res.status !== 0) {
      throw Object.assign(new Error(`弹窗进程退出码 ${String(res.status)}`), { code: 3 });
    }
    let raw;
    try {
      raw = readFileSync(outputPath, 'utf8');
    } catch {
      throw Object.assign(new Error('弹窗未产生结果文件'), { code: 3 });
    }
    const result = JSON.parse(raw.replace(/^\ufeff/, ''));
    return { action: result.action, specs: result.specs ?? [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ────────────────────────── 执行 ────────────────────────── */

function runPlaywright(specs) {
  if (specs.length === 0) {
    console.error('[e2e-select] ❌ 没有选中任何 spec，未执行。');
    process.exit(2);
  }
  const entries = loadManifest();
  const picked = entries
    .filter((entry) => specs.includes(entry.spec))
    .sort((a, b) => a.spec.localeCompare(b.spec));
  const unknown = specs.filter((spec) => !entries.some((entry) => entry.spec === spec));
  if (unknown.length > 0) {
    fail(`manifest 中不存在这些 spec：${unknown.join('、')}（--list 查看全部）`);
  }
  const files = picked.map((entry) => `tests/e2e/${entry.spec}`);
  console.log(
    `\n[e2e-select] 执行 ${picked.length} 个 spec / ${picked.reduce((n, e) => n + e.tests, 0)} 例` +
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

if (args.all) {
  runPlaywright(entries.map((entry) => entry.spec));
}

if (args.specs.length > 0) {
  runPlaywright(args.specs);
}

if (args.dryRun) {
  console.log('[e2e-select] dry-run（仅打印，不执行）');
  reportSelection(selection);
  process.exit(0);
}

const interactive = args.interactive || (process.stdin.isTTY && !process.env.CI);
if (!interactive) {
  reportSelection(selection);
  console.error(
    '\n[e2e-select] ❌ 非交互环境（无 TTY / CI）：为避免静默弹窗或静默全量，未执行任何 spec。\n' +
      '  请显式指定：--all（全量）或 --specs=a.spec.ts,b.spec.ts。\n' +
      '  人工验收弹窗可加 --interactive。',
  );
  process.exit(3);
}

const result = (() => {
  try {
    return showDialog(selection);
  } catch (error) {
    console.error(
      `[e2e-select] ❌ 无法弹出选择窗口：${error instanceof Error ? error.message : String(error)}`,
    );
    console.error('  请显式指定 --all 或 --specs=...；无 GUI 环境不允许静默弹窗。');
    process.exit(3);
  }
})();
if (result.action !== 'run') {
  console.log('[e2e-select] 已取消，未执行任何 spec。');
  process.exit(2);
}
runPlaywright(result.specs);
