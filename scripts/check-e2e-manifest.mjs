#!/usr/bin/env node
/**
 * G20 硬门禁：E2E manifest 与 spec 文件双向一致
 *
 * 背景（2026-11-10）：本地改按需跑 E2E 后，「新增 spec 忘记登记 manifest」会让
 * 新用例永远不被选择器推荐（本地永远不跑、只有 CI 兜底），而「删除 spec 忘记
 * 清理 manifest」会让选择器推荐一个不存在的文件、playwright 直接报错。
 * 两种情况都不会让某一方单独变红，只能靠机械比对。
 *
 * 判定：
 *   - 每个 apps/desktop/tests/e2e/**\/*.spec.ts 必须在 manifest 有条目
 *   - 每条 manifest 条目必须有对应 spec 文件（孤儿条目 → fail）
 *   - 字段类型 / deps 枚举 / triggers 非空 / tests 与 durationSec 为正数
 *
 * 用法：node scripts/check-e2e-manifest.mjs [--json]
 * 退出码：0 通过；1 发现缺失 / 孤儿 / 非法条目
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePath, validateManifest } from './lib/e2e-select-core.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e2eDir = join(repoRoot, 'apps', 'desktop', 'tests', 'e2e');
const manifestPath = join(e2eDir, 'manifest.json');

/** 递归收集 spec 文件（相对 e2e 目录，POSIX 风格） */
function collectSpecs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // helpers 纯函数目录不含 spec；仍递归以防未来分层
      out.push(...collectSpecs(full));
    } else if (name.endsWith('.spec.ts')) {
      out.push(normalizePath(relative(e2eDir, full)));
    }
  }
  return out.sort();
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(
    `[check:e2e-manifest] ❌ 无法读取 ${normalizePath(relative(repoRoot, manifestPath))}`,
  );
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const specFiles = collectSpecs(e2eDir);
const { errors, count } = validateManifest(manifest, specFiles);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ specs: specFiles.length, entries: count, errors }, null, 2));
  process.exitCode = errors.length > 0 ? 1 : 0;
} else if (errors.length > 0) {
  console.error(
    `[check:e2e-manifest] ❌ ${errors.length} 处问题（spec ${specFiles.length} 个 / 条目 ${count} 条）：`,
  );
  for (const error of errors) console.error(`  - ${error}`);
  console.error(
    '\n[check:e2e-manifest] 修法：在 apps/desktop/tests/e2e/manifest.json 补条目或删除孤儿条目；\n' +
      '  触发路径与耗时口径见 docs/E2E用例选择表.md。',
  );
  process.exitCode = 1;
} else {
  console.log(
    `[check:e2e-manifest] ok（${count} 条 manifest ↔ ${specFiles.length} 个 spec 文件双向一致）`,
  );
}
