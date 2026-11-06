/**
 * DSH 版本三源一致性检查（P2-13 / ADR-016 接入 pnpm verify）
 *
 * 背景：dsh 有三处版本必须一致，此前无任何机器校验（调研报告 §7.2）：
 *   ① apps/desktop/package.json 的依赖 "@deepseek-ai/dsh"（精确 pin）——唯一真源
 *   ② 根 pnpm-lock.yaml（打包态实际安装的版本）
 *   ③ vendor/deepseek-harness/package.json（开发态运行的源码版本）
 * 任何一处不同步都会出现「打包态 / 开发态行为不一致」的隐性分裂，例如改了
 * 桌面依赖版本却忘记重新拉取 vendor——dev 跑旧代码、prod 跑新代码。
 *
 * 规则：
 *   - ① 不存在或非精确 pin → fail（版本真源不明确的本身就是错误）
 *   - ② 不含 ① 的版本 → fail（改依赖未更新 lockfile）
 *   - ③ 存在但版本 ≠ ① → fail 并提示 `pnpm sync:dsh`
 *   - ③ 不存在（CI / 未同步的新机器）→ 只提示不失败：vendor 树不在
 *     版本控制内（ADR-016），CI 环境本来就没有，检查只对本地开发生效。
 *
 * 用法：node scripts/check-dsh-version.mjs（经 package.json 的 check:dsh）
 * 退出码：0 通过；1 发现不一致
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const desktopPkgPath = join(repoRoot, 'apps', 'desktop', 'package.json');
const lockfilePath = join(repoRoot, 'pnpm-lock.yaml');
const vendorPkgPath = join(repoRoot, 'vendor', 'deepseek-harness', 'package.json');

function fail(msg) {
  console.error(`[check-dsh] ❌ ${msg}`);
  process.exit(1);
}

/* ① 版本真源：桌面包的精确依赖 */
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'));
const dep = desktopPkg.dependencies?.['@deepseek-ai/dsh'];
if (!dep) {
  fail('apps/desktop/package.json 未声明 @deepseek-ai/dsh——三源检查的锚点缺失');
}
if (!/^\d/.test(dep)) {
  fail(`@deepseek-ai/dsh 依赖="${dep}" 非精确 pin（含 ^/~）——版本真源必须唯一确定（ADR-016）`);
}

/* ② 打包态：lockfile 必须锁定同一版本 */
const lockfile = readFileSync(lockfilePath, 'utf8');
if (!lockfile.includes(`@deepseek-ai/dsh@${dep}`)) {
  fail(
    `pnpm-lock.yaml 未锁定 @deepseek-ai/dsh@${dep}——依赖与 lockfile 不一致，` +
      '请重新 `pnpm install`（或核对是否漏改 lockfile）',
  );
}

/* ③ 开发态：vendor 树（存在才检查；CI / 未同步环境没有它） */
if (existsSync(vendorPkgPath)) {
  let vendorVersion = null;
  try {
    vendorVersion = JSON.parse(readFileSync(vendorPkgPath, 'utf8')).version ?? null;
  } catch {
    fail('vendor/deepseek-harness/package.json 无法解析，目录疑似损坏——`pnpm sync:dsh` 重建');
  }
  if (vendorVersion !== dep) {
    fail(
      `vendor 源码版本 ${vendorVersion} ≠ 桌面依赖 ${dep}——开发态/打包态将跑不同代码。` +
        '执行 `pnpm sync:dsh` 重建后重试',
    );
  }
  const installed = existsSync(join(repoRoot, 'vendor', 'deepseek-harness', 'node_modules'));
  if (!installed) {
    console.log(
      '[check-dsh] ℹ vendor 依赖未安装（node_modules 缺失），开发态 dsh 启动前请先 `pnpm sync:dsh`',
    );
  }
  console.log(`[check-dsh] ✅ 三源一致：桌面依赖 = lockfile = vendor = ${dep}`);
} else {
  console.log(
    `[check-dsh] ✅ 桌面依赖 = lockfile = ${dep}；vendor/deepseek-harness 未拉取（开发 dsh 前先 \`pnpm sync:dsh\`）`,
  );
}
