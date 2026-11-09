#!/usr/bin/env node
/**
 * G18 硬门禁：源码 / 测试目录内不允许出现被 .gitignore 忽略的文件
 *
 * 起因（2026-11-09 实测）：`.gitignore` 里的 `logs/` 是全仓通配，把源码目录
 * `apps/desktop/src/main/logs/`（index.ts / log-store.ts / register-handlers.ts）
 * 整体吞掉——三个源文件从未入库。本机 `pnpm typecheck` 一直是绿的（文件在磁盘上），
 * 而 CI 干净 clone 直接 TS2307 Cannot find module './logs'，CI 自那一刻起每次全红，
 * 且因为「忽略文件在 git status 里根本不显示」，靠人肉发现不现实。
 *
 * 判定：`git ls-files --others --ignored --exclude-standard` 在 `apps/&#42;/src`、
 * `apps/&#42;/tests`、`packages/&#42;/src`、`packages/&#42;/tests` 范围内必须为空。
 * 退出码：0 = 通过；1 = 存在被忽略的源码（阻止提交 / CI 失败）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const GROUPS = ['apps', 'packages'];
const SUBDIRS = ['src', 'tests'];
/**
 * 工具状态目录：由 .gitignore 有意忽略（AI 工具会话 / 报告），即使位于 src 或 tests 下也不属于源码。
 * 其余任何被忽略的文件一律视为「源码被吞」。
 */
const TOOL_STATE_DIRS = [/\/\.mimosa\//, /\/\.zcode\//, /\/\.workbuddy-ai\//];

/** 只扫描工作区包内的源码/测试目录，避开 node_modules 与打包产物（后者本来就该忽略） */
function sourceDirs() {
  const dirs = [];
  for (const group of GROUPS) {
    if (!existsSync(group)) continue;
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const sub of SUBDIRS) {
        const dir = join(group, entry.name, sub);
        if (existsSync(dir)) dirs.push(dir);
      }
    }
  }
  return dirs;
}

function ignoredUnder(dirs) {
  if (dirs.length === 0) return [];
  const raw = execFileSync(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...dirs],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return raw
    .split('\0')
    .filter(Boolean)
    .filter((file) => !TOOL_STATE_DIRS.some((re) => re.test(`/${file}`)));
}

const dirs = sourceDirs();
const ignored = ignoredUnder(dirs);

if (ignored.length > 0) {
  console.error('[check:src] 以下源码 / 测试文件被 .gitignore 忽略，永远不会进入仓库：');
  for (const file of ignored) console.error(`  - ${file}`);
  console.error(
    '\n[check:src] 修法：把命中的 .gitignore 规则收窄（例：`logs/` → `/logs/`，只忽略仓库根日志目录），' +
      '或为源码目录加显式例外（`!apps/desktop/src/main/logs/`）。\n' +
      '[check:src] 危害：本地编译/测试正常，干净 clone（CI）缺文件直接报 TS2307。',
  );
  process.exit(1);
}

console.log(`[check:src] ok（${dirs.length} 个源码目录，无被忽略的源码文件）`);
