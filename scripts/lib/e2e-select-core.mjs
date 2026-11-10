/**
 * E2E 按需选择核心逻辑（纯函数，无 IO / 无 Electron 依赖）
 *
 * 为什么要独立成模块（2026-11-10）：
 * 运行器 `scripts/e2e-select.mjs` 需要读 git 状态、起子进程，无法在单测里稳定验证；
 * 而「哪些改动该跑哪些 spec」是本机制唯一的判断逻辑，必须能被确定性测试覆盖。
 * 因此把匹配 / 推荐 / manifest 校验全部收在这里，运行器只做 IO 与交互。
 *
 * 数据真源：apps/desktop/tests/e2e/manifest.json（每个 spec 一条，触发路径 + 依赖 + 耗时）。
 * 运行策略见 docs/E2E用例选择表.md：AI 不得默认全量跑，先出表 → 给建议 → 用户勾选；
 * 全量仅限发布前、选择器无法判定、或用户明确要求。CI 仍全量（pnpm e2e）。
 */

/** 允许的依赖枚举（与 manifest 字段约定一致） */
export const DEP_VALUES = Object.freeze(['genoffice-artifact', 'vendor-dsh', 'api-key', 'none']);

/** manifest 每条必须具备的字段 */
export const REQUIRED_FIELDS = Object.freeze([
  'spec',
  'area',
  'tests',
  'durationSec',
  'triggers',
  'deps',
  'ciRuns',
  'alwaysRecommend',
  'note',
]);

/** 仓库相对路径归一化：反斜杠 → 正斜杠，去掉 ./ 前缀 */
export function normalizePath(file) {
  return String(file ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/**
 * glob → 正则（锚定整串）。
 *
 * 只支持 manifest 实际需要的三种通配：
 * - `**` 跨目录任意字符；`**` 后紧跟 `/` 时可匹配 0 层目录
 * - `*`  单层任意字符（不跨 `/`）
 * - `?`  单个非 `/` 字符
 * 其余字符一律按字面量转义——避免 `.` `/` `+` 等在正则里变成元字符。
 */
export function globToRegExp(glob) {
  const pattern = normalizePath(glob);
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` → 可选的多层目录前缀；裸 `**` → 任意字符
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.*+?()[]{}|'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out);
}

/** 判断单个文件是否命中任一 trigger glob */
export function matchesTriggers(file, triggers) {
  const target = normalizePath(file);
  return (triggers ?? []).some((glob) => globToRegExp(glob).test(target));
}

/** 文档类路径：docs/ 下任意文件 + 仓库根目录的 Markdown / 许可证 */
const DOC_PATTERNS = [/^docs\//, /^[^/]+\.md$/i, /^LICENSE(?:\.md)?$/i];

/** 改动是否全部为文档（文档改动无需 E2E） */
export function isDocOnly(files) {
  const list = (files ?? []).map(normalizePath).filter(Boolean);
  return list.length > 0 && list.every((file) => DOC_PATTERNS.some((re) => re.test(file)));
}

function totalDuration(entries) {
  return entries.reduce((sum, entry) => sum + (Number(entry.durationSec) || 0), 0);
}

/**
 * 根据改动文件计算推荐集合。
 *
 * 返回：
 * - mode: 'matched' | 'doc-only' | 'no-match' | 'unknown'
 * - recommended: [{ ...manifestEntry, reasons: string[] }]
 * - totalDurationSec: 推荐集合预估总耗时（秒）
 * - note: 给用户看的一句话结论（中文）
 */
export function selectSpecs({ changedFiles, entries }) {
  const files = (changedFiles ?? []).map(normalizePath).filter(Boolean);
  const all = [...entries].sort((a, b) => a.spec.localeCompare(b.spec));

  if (files.length === 0) {
    return {
      mode: 'unknown',
      files,
      recommended: all.map((entry) => ({ ...entry, reasons: ['无法判定改动范围'] })),
      totalDurationSec: totalDuration(all),
      note: '无法判定改动范围（无改动 / git 查询失败），按策略建议全量。',
    };
  }

  if (isDocOnly(files)) {
    return {
      mode: 'doc-only',
      files,
      recommended: [],
      totalDurationSec: 0,
      note: '文档改动无需 E2E。',
    };
  }

  // 先按 triggers 做纯匹配：alwaysRecommend 只是基线并集，不能让「无匹配」变成「命中 1 条」。
  const hitsBySpec = new Map();
  for (const entry of all) {
    const hits = files.filter((file) => matchesTriggers(file, entry.triggers));
    if (hits.length > 0) hitsBySpec.set(entry.spec, hits);
  }

  if (hitsBySpec.size === 0) {
    return {
      mode: 'no-match',
      files,
      recommended: all.map((entry) => ({ ...entry, reasons: ['无触发规则命中'] })),
      totalDurationSec: totalDuration(all),
      note: '改动没有命中任何 manifest 触发路径，按策略建议全量（避免漏测）。',
    };
  }

  const matched = [];
  for (const entry of all) {
    const hits = hitsBySpec.get(entry.spec);
    const reasons = [];
    if (hits) {
      const shown = hits.slice(0, 3).join('、');
      reasons.push(`命中改动 ${shown}${hits.length > 3 ? ` 等 ${hits.length} 个` : ''}`);
    }
    if (entry.alwaysRecommend) reasons.push('基线：核心启动链路，任何改动都建议跑');
    if (reasons.length > 0) matched.push({ ...entry, reasons });
  }

  return {
    mode: 'matched',
    files,
    recommended: matched,
    totalDurationSec: totalDuration(matched),
    note: `命中 ${matched.length} 个 spec，预估约 ${totalDuration(matched)} 秒。`,
  };
}

/**
 * manifest 合法性校验（check:e2e-manifest 与单测共用）。
 *
 * 双向比对：spec 目录里有的文件必须在 manifest 有条目（缺失 → 新 spec 逃过选择机制）；
 * manifest 有条目必须有对应文件（孤儿 → 已删除 spec 继续被推荐，跑起来直接失败）。
 */
export function validateManifest(manifest, specFiles) {
  const errors = [];
  const entries = Array.isArray(manifest?.specs) ? manifest.specs : null;
  if (!entries) return { errors: ['manifest 顶层必须是 { "specs": [...] }'], count: 0 };

  const known = new Set((specFiles ?? []).map(normalizePath));
  const seen = new Set();

  entries.forEach((entry, index) => {
    const at = `specs[${index}]`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${at} 不是对象`);
      return;
    }
    for (const field of REQUIRED_FIELDS) {
      if (!(field in entry)) errors.push(`${at} 缺字段 "${field}"`);
    }
    const spec = normalizePath(entry.spec);
    if (!spec) {
      errors.push(`${at}.spec 为空`);
    } else {
      if (!spec.endsWith('.spec.ts')) errors.push(`${at}.spec 必须以 .spec.ts 结尾：${spec}`);
      if (seen.has(spec)) errors.push(`${at}.spec 重复：${spec}`);
      seen.add(spec);
      if (known.size > 0 && !known.has(spec))
        errors.push(`${at}.spec 没有对应文件（孤儿条目）：${spec}`);
    }
    if (!Number.isInteger(entry.tests) || entry.tests <= 0) {
      errors.push(`${at}.tests 必须是正整数：${String(entry.tests)}`);
    }
    if (typeof entry.durationSec !== 'number' || !(entry.durationSec > 0)) {
      errors.push(`${at}.durationSec 必须是正数（秒）：${String(entry.durationSec)}`);
    }
    if (!Array.isArray(entry.triggers) || entry.triggers.length === 0) {
      errors.push(`${at}.triggers 必须是非空 glob 数组`);
    } else if (entry.triggers.some((glob) => typeof glob !== 'string' || !glob.trim())) {
      errors.push(`${at}.triggers 含空值或非字符串`);
    }
    if (!DEP_VALUES.includes(entry.deps)) {
      errors.push(`${at}.deps 必须是 ${DEP_VALUES.join(' | ')} 之一：${String(entry.deps)}`);
    }
    for (const flag of ['ciRuns', 'alwaysRecommend']) {
      if (typeof entry[flag] !== 'boolean') errors.push(`${at}.${flag} 必须是布尔值`);
    }
    if (typeof entry.note !== 'string' || !entry.note.trim()) {
      errors.push(`${at}.note 必须是非空说明`);
    }
    if (typeof entry.area !== 'string' || !entry.area.trim()) {
      errors.push(`${at}.area 必须是非空能力域`);
    }
  });

  for (const spec of known) {
    if (!seen.has(spec)) errors.push(`缺少 manifest 条目：${spec}（新 spec 不会被选择器推荐）`);
  }

  return { errors, count: entries.length };
}
