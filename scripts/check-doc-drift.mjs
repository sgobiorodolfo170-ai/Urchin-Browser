/**
 * 文档漂移检查（docs/事实登记表.md 的执行器）
 *
 * 背景：同一个规范事实在仓库里存在多个副本（覆盖率阶梯 7 处、卡点描述 3 处…），
 * 任何一次修改都会留下未同步的副本。本脚本把这些「不许漂移」的事实变成可执行检查，
 * 接入 CI 后，漂移会在 PR 阶段被拦下，而不是等到某天有人照着过期文档操作。
 *
 * 检查项（对应事实登记表 F1/F2/F3）：
 *   R1 禁止出现错误命令 `pnpm test --coverage`（正确写法是 test:coverage）
 *   R2 禁止把 pre-commit 描述成含 `tsc --noEmit`（实际钩子只有 lint-staged）
 *   R3 覆盖率阶梯数值序列必须与唯一真源 docs/03-技术栈 §4.1 一致
 *
 * 设计原则：
 * - 真源从 docs/03 §4.1 现场解析，不在本脚本里再抄一份数字（否则脚本自己就是第 8 个副本）
 * - 允许单点引用某个门槛值（如「v0.1 ≥60%」），只校验「成串出现」的阶梯序列
 * - 历史文档（CHANGELOG / ADR-008）豁免：它们记录的是当时的事实，不应回改
 *
 * 用法：node scripts/check-doc-drift.mjs [--json]
 * 退出码：0 通过；1 发现漂移
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 历史文档：记录当时的事实，允许与当前规范不同 */
const HISTORY_EXEMPT = new Set(['CHANGELOG.md', 'docs/decisions/ADR-008-v0.1范围与工期.md']);

/**
 * 规则手册：本表与脚本自身的文档必须能「引用」错误示例（否则无法说明规则是什么），
 * 因此豁免 R1-R3，但仍接受 R4（CHANGELOG 格式）检查。
 */
const RULEBOOK_EXEMPT = new Set(['docs/事实登记表.md']);

/**
 * 已知的历史版本号重复：v0.1.0-dev.65 有两个迭代条目（窗口尺寸记忆 / pi 左区重构）。
 * 修正需把其后约 57 行全部重编号，代价远大于收益，故登记豁免；
 * 新增重复一律视为错误（防止以后再出现「两个迭代共用一个版本号」）。
 */
const KNOWN_DUPLICATE_VERSIONS = new Set(['v0.1.0-dev.65']);

const TRUTH_SOURCE = 'docs/03-技术栈.md';

/** 收集待检文件：docs/**\/*.md + 根目录 md + CI 工作流（yml 里也会复述命令） */
function collectFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md')) out.push(p);
    }
  };
  walk(join(repoRoot, 'docs'));
  for (const name of ['AGENTS.md', 'README.md', 'RELEASE_NOTES.md', 'CHANGELOG.md']) {
    try {
      statSync(join(repoRoot, name));
      out.push(join(repoRoot, name));
    } catch {
      /* 文件不存在则跳过 */
    }
  }
  // CI 工作流：注释里同样会复述卡点命令，属同源漂移面
  try {
    const wf = join(repoRoot, '.github/workflows');
    for (const name of readdirSync(wf)) {
      if (name.endsWith('.yml') || name.endsWith('.yaml')) out.push(join(wf, name));
    }
  } catch {
    /* 无 workflows 目录则跳过 */
  }
  return out.map((p) => relative(repoRoot, p).replace(/\\/g, '/'));
}

/**
 * 从唯一真源解析覆盖率阶梯（§4.1 表格里「整体单元覆盖率」那一行的 ≥NN% 序列）。
 * 只取该行，避免把同节下方的「实测记录」表格混进来。
 * 解析失败直接抛错——真源都读不出来时，宁可不检查也不能误判通过。
 */
function readCanonicalLadder() {
  const text = readFileSync(join(repoRoot, TRUTH_SOURCE), 'utf8');
  const row = text.match(/^\|\s*整体单元覆盖率\s*\|.*$/m);
  if (!row) throw new Error(`无法在 ${TRUTH_SOURCE} 定位 §4.1「整体单元覆盖率」行`);
  const nums = [...row[0].matchAll(/≥(\d+)%/g)].map((m) => Number(m[1]));
  if (nums.length < 3) throw new Error(`§4.1 阶梯解析结果异常：${nums.join(',')}`);
  return nums;
}

const violations = [];
const push = (rule, file, line, detail) => violations.push({ rule, file, line, detail });

function checkFile(file, canonical) {
  if (HISTORY_EXEMPT.has(file)) return;
  if (RULEBOOK_EXEMPT.has(file)) return;
  const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
  /** 当前是否处在「表头含 3 个以上版本标签」的表格里——阶梯通常写成表格，
   *  版本标签在表头行、数值在数据行，必须跨行记住上下文 */
  let inVersionTable = false;

  lines.forEach((text, i) => {
    const lineNo = i + 1;
    const isTableRow = text.trimStart().startsWith('|');
    const labels = (text.match(/v0\.[1-5]|v1\.0/g) || []).length;

    if (!isTableRow) inVersionTable = false;
    if (isTableRow && labels >= 3) inVersionTable = true;

    // R1：错误命令（test --coverage 不是仓库里存在的 script）
    if (/pnpm\s+test\s+--coverage/.test(text)) {
      push('R1', file, lineNo, '命令不存在，应写作 `pnpm test:coverage`');
    }

    // R2：pre-commit 描述与实际钩子不符
    const mentionsHook = /pre-commit|precommit|提交时/i.test(text);
    if (mentionsHook && /tsc\s+--noEmit/.test(text)) {
      push('R2', file, lineNo, 'pre-commit 实际只跑 lint-staged（ESLint+Prettier），不含 tsc');
    }

    // R3：成串出现的覆盖率阶梯必须与真源一致
    // 触发条件：本行自带 3 个以上版本标签，或本行属于「版本表头」所在的表格
    // —— 这样只校验阶梯陈述，不会误判分层目标表（如「工具类 ≥95% / v0.1 ≥90%」）
    const seq = [...text.matchAll(/≥(\d+)%/g)].map((m) => Number(m[1]));
    const ladderContext = labels >= 3 || (isTableRow && inVersionTable);
    if (ladderContext && seq.length >= 3) {
      const startsRight = seq[0] === canonical[0];
      const endsRight = seq.at(-1) === canonical.at(-1);
      const monotonic = seq.every((v, idx) => idx === 0 || v >= seq[idx - 1]);
      const allKnown = seq.every((v) => canonical.includes(v));
      if (!startsRight || !endsRight || !monotonic || !allKnown) {
        push(
          'R3',
          file,
          lineNo,
          `阶梯序列 [${seq.join(',')}] 与真源 [${canonical.join(',')}] 不一致`,
        );
      }
    }
  });
}

/**
 * R4：CHANGELOG 版本行格式（AGENTS.md §四：版本号 + 日期 + 摘要）
 *
 * CHANGELOG 在 R1-R3 里是豁免的（历史记录不该回改），但它的**格式**必须始终可解析——
 * 因为 `scripts/build-version.mjs` 靠解析表尾最后一行来盖章版本号，格式一乱打包就失败。
 */
function checkChangelog() {
  const file = 'CHANGELOG.md';
  let lines;
  try {
    lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
  } catch {
    return; // 没有 CHANGELOG 时不检查
  }
  const seen = new Map();
  lines.forEach((text, i) => {
    if (!/^\|\s*v\d/.test(text)) return;
    const m = text.match(/^\|\s*(v\d+\.\d+\.\d+(?:-dev\.\d+)?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/);
    if (!m) {
      push('R4', file, i + 1, '版本行格式应为 `| vX.Y.Z[-dev.NNN] | YYYY-MM-DD | 摘要 |`');
      return;
    }
    const [, version, date] = m;
    if (seen.has(version)) {
      if (!KNOWN_DUPLICATE_VERSIONS.has(version)) {
        push('R4', file, i + 1, `版本号重复：${version}（首次出现在第 ${seen.get(version)} 行）`);
      }
    } else {
      seen.set(version, i + 1);
    }
    if (Number.isNaN(Date.parse(date))) push('R4', file, i + 1, `日期非法：${date}`);
  });
}

function main() {
  const canonical = readCanonicalLadder();
  const files = collectFiles();
  for (const f of files) checkFile(f, canonical);
  checkChangelog();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ canonical, files: files.length, violations }, null, 2));
    process.exitCode = violations.length > 0 ? 1 : 0;
    return;
  }

  console.log(
    `[doc-drift] 真源 ${TRUTH_SOURCE} §4.1 阶梯：${canonical.map((n) => `≥${n}%`).join(' → ')}`,
  );
  console.log(
    `[doc-drift] 扫描 ${files.length} 个 markdown 文件（豁免 ${HISTORY_EXEMPT.size} 个历史文档）`,
  );

  if (violations.length === 0) {
    console.log('[doc-drift] ✅ 未发现漂移');
    return;
  }

  console.error(`\n[doc-drift] ❌ 发现 ${violations.length} 处漂移：\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}] ${v.detail}`);
  }
  console.error('\n修复方式见 docs/事实登记表.md；如属历史记录，请加入脚本的 HISTORY_EXEMPT。');
  process.exitCode = 1;
}

main();
