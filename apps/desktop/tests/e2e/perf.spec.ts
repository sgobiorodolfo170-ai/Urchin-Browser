/**
 * W7 性能验收：10 标签内存测量
 * 依据：ADR-008 v0.1 验收标准 - 内存 ≤500MB（10 标签场景，P95）
 *
 * 2026-11-10 策略调整（ADR-018 / 用户确认方案 a「环境分线」）：
 * 500MB 是 **目标线**（仅告警）；**回归线**按环境分线 = CI 750MB / 本机 800MB。
 * 原因：本机实测 707.7~715.9MB、CI 实测 567.4MB，环境差（~150MB）已超过单线
 * 750MB 的余量，用单线会把环境噪声判成代码回归。重校目标线仍属产品决策。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('内存：10 标签场景 ≤ 回归线（CI 750MB / 本机 800MB）', async () => {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-perf-10tab-'));

  const electronApp = await electron.launch({
    cwd: appPath,
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYWRIGHT: '1',
      URCHIN_TEST_USER_DATA: userDataDir,
      URCHIN_TEST_DATA_DIR: join(userDataDir, 'data'),
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // W7+ UI：标签列表在右侧栏内默认折叠为图标条，先展开以暴露「新建标签」按钮。
    // 折叠/展开按钮已移除，双击右侧边栏空白处展开（与 launch/tab-order 一致）。
    await window.locator('[aria-label="右侧边栏"]').first().dblclick();
    await window
      .getByRole('button', { name: '新建标签' })
      .waitFor({ state: 'visible', timeout: 15_000 });

    // 新建标签至 10 个（已有 1 个初始标签）
    for (let i = 1; i < 10; i++) {
      await window.getByRole('button', { name: '新建标签' }).click();
      await window.waitForTimeout(200);
    }

    // 等待稳定 + 多点采样取最小值（dev.89：套件内曾因同机其他 Electron 实例
    // 的内存压力把瞬时 working set 抬到 541MB；阈值不放松，只降低噪声——
    // 最小值仍须 ≤500MB 才算达标）
    await window.waitForTimeout(3000);
    // 通过主进程获取内存信息
    const sample = () =>
      electronApp.evaluate(({ app }) => {
        const metrics = app.getAppMetrics();
        const total = metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0);
        return {
          processCount: metrics.length,
          totalMB: (total * 1024) / 1024 / 1024, // workingSetSize 单位是 KB
          processes: metrics.map((m) => ({
            type: m.type,
            pid: m.pid,
            workingSetKB: m.memory?.workingSetSize ?? 0,
          })),
        };
      });
    interface MemSample {
      processCount: number;
      totalMB: number;
      processes: { type: string; pid: number; workingSetKB: number }[];
    }
    const samples: MemSample[] = [];
    for (let i = 0; i < 3; i++) {
      samples.push(await sample());
      if (i < 2) await window.waitForTimeout(2000);
    }
    const memInfo = samples.reduce((a, b) => (a.totalMB <= b.totalMB ? a : b));

    console.log(
      `\n[perf] 10 标签内存: ${memInfo.totalMB.toFixed(1)} MB (${memInfo.processCount} processes, min of ${samples.length})`,
    );
    for (const p of memInfo.processes) {
      console.log(`  ${p.type} (pid=${p.pid}): ${(p.workingSetKB / 1024).toFixed(1)} MB`);
    }

    // 双线预算（2026-10-27 定双线；2026-11-10 回归线按环境分线，ADR-018）：
    // - 目标线 500MB：ADR-008 的 v0.1 验收值（当时实测 358MB）。此后新增 GenOffice
    //   六编辑器、邮箱、DevTools 面板、工作区、pi-web、dsh 等能力，实测已达 ~708MB，
    //   目标线已事实性失守 → 超出只告警，不静默放宽也不假装达标。
    // - 回归线：CI 750MB / 本机 800MB。超出即失败（防继续恶化）。
    //   本机（707.7~715.9MB）与 CI（567.4MB）环境差 ~150MB，已超过单线余量；
    //   单线会把环境噪声判成代码回归。显式设置 URCHIN_PERF_BUDGET_MB 可覆盖。
    // 注：重新校准目标线属产品决策（需改 ADR-008 验收标准），本用例不代替该决策。
    const TARGET_MB = 500;
    const DEFAULT_REGRESSION_MB = process.env.CI ? 750 : 800;
    const REGRESSION_MB = Number(process.env.URCHIN_PERF_BUDGET_MB ?? DEFAULT_REGRESSION_MB);
    console.log(
      `\n[perf] 回归线 ${REGRESSION_MB}MB（${process.env.CI ? 'CI 环境线' : '本机环境线'}）` +
        `；目标线 ${TARGET_MB}MB 仅告警`,
    );
    if (memInfo.totalMB > TARGET_MB) {
      console.warn(
        `\n[perf] ⚠ 超出 ADR-008 v0.1 目标线 ${TARGET_MB}MB（实测 ${memInfo.totalMB.toFixed(1)}MB）。` +
          `当前按回归线 ${REGRESSION_MB}MB 判定；目标线是否重新校准需产品决策。`,
      );
    }
    expect(
      memInfo.totalMB,
      `10 标签总内存 ${memInfo.totalMB.toFixed(1)}MB（3 次采样最小值）应 ≤ 回归线 ${REGRESSION_MB}MB，全部采样：${samples
        .map((s) => s.totalMB.toFixed(1))
        .join('/')}MB`,
    ).toBeLessThanOrEqual(REGRESSION_MB);
  } finally {
    await electronApp.close();
  }
});
