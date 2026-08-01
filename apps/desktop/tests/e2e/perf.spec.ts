/**
 * W7 性能验收：10 标签内存测量
 * 依据：ADR-008 v0.1 验收标准 - 内存 ≤500MB（10 标签场景，P95）
 */
import { test, expect, _electron as electron } from '@playwright/test';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('内存：10 标签场景 ≤500MB', async () => {
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
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window
      .getByRole('button', { name: '新建标签' })
      .waitFor({ state: 'visible', timeout: 15_000 });

    // 新建标签至 10 个（已有 1 个初始标签）
    for (let i = 1; i < 10; i++) {
      await window.getByRole('button', { name: '新建标签' }).click();
      await window.waitForTimeout(200);
    }

    // 等待稳定
    await window.waitForTimeout(3000);

    // 通过主进程获取内存信息
    const memInfo = await electronApp.evaluate(({ app }) => {
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

    console.log(
      `\n[perf] 10 标签内存: ${memInfo.totalMB.toFixed(1)} MB (${memInfo.processCount} processes)`,
    );
    for (const p of memInfo.processes) {
      console.log(`  ${p.type} (pid=${p.pid}): ${(p.workingSetKB / 1024).toFixed(1)} MB`);
    }

    // v0.1 验收：≤500MB
    expect(
      memInfo.totalMB,
      `10 标签总内存 ${memInfo.totalMB.toFixed(1)}MB 应 ≤ 500MB`,
    ).toBeLessThanOrEqual(500);
  } finally {
    await electronApp.close();
  }
});
