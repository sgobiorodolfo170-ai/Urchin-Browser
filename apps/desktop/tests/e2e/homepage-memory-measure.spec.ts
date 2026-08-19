/**
 * 测量：主页（urchin://newtab）标签的内存占用
 *
 * 方法：app.getAppMetrics() 采集所有 Electron 进程的工作集内存，
 * 对比 新建主页标签 前后 的进程数 + 内存增量。
 */
import { test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Metric {
  pid: number;
  type: string;
  wskb: number;
}

async function launchApp(): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-mem-'));

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

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window };
}

/** 从 Electron 取进程列表（pid + type），再在 Node 侧用 PowerShell 读 OS 层工作集 */
async function memSnapshot(electronApp: ElectronApplication): Promise<Metric[]> {
  const { execFileSync } = await import('node:child_process');
  const procs = (await electronApp.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type })),
  )) as { pid: number; type: string }[];

  let rows: { Id: number; WS: number }[] = [];
  try {
    const cmd = `Get-Process -Id ${procs.map((p) => p.pid).join(',')} -ErrorAction SilentlyContinue | Select-Object Id, WS | ConvertTo-Json -Compress`;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 15000,
    });
    const parsed: unknown = JSON.parse(out.trim() || 'null');
    if (Array.isArray(parsed)) {
      rows = parsed as { Id: number; WS: number }[];
    } else if (parsed) {
      rows = [parsed as { Id: number; WS: number }];
    }
  } catch {
    /* 采集失败回退 0 */
  }

  return procs.map((p) => {
    const row = rows.find((r) => r.Id === p.pid);
    return { pid: p.pid, type: p.type, wskb: row ? Math.round(row.WS / 1024) : 0 };
  });
}

function summarize(label: string, metrics: Metric[]): void {
  const total = metrics.reduce((s, m) => s + m.wskb, 0);
  const tabs = metrics.filter((m) => m.type === 'Tab');
  const tabWs = tabs.reduce((s, m) => s + m.wskb, 0);
  console.log(
    `=== ${label} === 总进程 ${metrics.length} | 渲染进程(Tab) ${tabs.length} | ` +
      `渲染进程总 ${(tabWs / 1024).toFixed(1)} MB | 全部进程总 ${(total / 1024).toFixed(1)} MB`,
  );
  for (const t of tabs) console.log(`   Tab PID ${t.pid}: ${(t.wskb / 1024).toFixed(1)} MB`);
}

test('测量主页标签内存', async () => {
  const { electronApp, window } = await launchApp();
  // 右侧栏默认折叠，先双击展开再等新建标签按钮
  await window.locator('[aria-label="右侧边栏"]').first().dblclick();
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });

  // 等启动稳定（首屏加载完成）
  await window.waitForTimeout(3000);
  const snap0 = await memSnapshot(electronApp);
  summarize('初始(含默认标签)', snap0);

  // 新建 1 个主页标签
  await window.getByRole('button', { name: '新建标签' }).click();
  await window.waitForTimeout(3000); // 等渲染进程起来
  const snap1 = await memSnapshot(electronApp);
  summarize('新建 1 个主页标签后', snap1);

  // 再新建 2 个主页标签（看是否每标签一个渲染进程、线性增长）
  await window.getByRole('button', { name: '新建标签' }).click();
  await window.getByRole('button', { name: '新建标签' }).click();
  await window.waitForTimeout(3000);
  const snap2 = await memSnapshot(electronApp);
  summarize('共 3 个主页标签时', snap2);

  // 把主页标签逐个关掉（验证释放）
  const closeBtns = window.locator('[aria-label="关闭标签"]');
  const n = await closeBtns.count();
  for (let i = 0; i < n; i++) {
    await closeBtns.first().click();
    await window.waitForTimeout(800);
  }
  const snap3 = await memSnapshot(electronApp);
  summarize('全部关闭主页标签后', snap3);

  await electronApp.close();
});
