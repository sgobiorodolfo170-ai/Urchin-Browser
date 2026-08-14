/**
 * 验证：网页区左上角 20px 圆角（纯 CSS 方案）
 *
 * 2026-08-15 方案：主进程 computeViewBounds 让网页 view 从 y=20 开始，
 * 渲染层 React 在顶部让出区画 surface 色圆角块（rounded-tl-20px）。
 * 断言：网页 view bounds.y=20（顶部让出）；无 data: 角盖 view（旧方案已移除）；
 * React 圆角块存在且 rounded-tl-[20px]；截图人工查看。
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('网页区左上角圆角（纯 CSS 方案）', async () => {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-corner-'));

  const electronApp: ElectronApplication = await electron.launch({
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
  // 主窗口 = URL 含 dist/renderer/index.html 的页面
  let window: Page | null = null;
  for (let i = 0; i < 20 && !window; i++) {
    await electronApp.waitForEvent('window', { timeout: 5000 }).catch(() => undefined);
    window =
      electronApp.windows().find((p) => p.url().includes('dist/renderer/index.html')) ?? null;
  }
  if (!window) throw new Error('主窗口未找到');
  await window.waitForLoadState('domcontentloaded');

  // 展开右侧栏（默认折叠）后导航外部网页
  await window.locator('[aria-label="右侧边栏"]').first().dblclick();
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  const omniboxInput = window.getByRole('textbox').first();
  await omniboxInput.fill('https://example.com');
  await omniboxInput.press('Enter');
  await expect(window.getByText('Example Domain')).toBeVisible({ timeout: 15_000 });
  await window.waitForTimeout(1500);

  // 断言 1：主窗口仅 1 个 BrowserView（网页），无 data: 角盖 view（旧方案已移除）
  const viewsInfo = await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return { count: 0, views: [] as { bounds: unknown; url: string }[] };
    return {
      count: win.getBrowserViews().length,
      views: win.getBrowserViews().map((v) => ({
        bounds: v.getBounds(),
        url: v.webContents.getURL().slice(0, 60),
      })),
    };
  });
  console.log('=== views ===', JSON.stringify(viewsInfo));
  expect(viewsInfo.count).toBe(1);
  expect(viewsInfo.views[0]?.url.startsWith('data:text/html')).toBe(false);

  // 断言 2：网页 view 顶部让出 20px（y=20，与左侧栏 x=44 对齐）
  const webView = viewsInfo.views[0]!;
  expect(webView.bounds).toMatchObject({ x: 44, y: 20 });

  // 断言 3：React 圆角块存在（rounded-tl-[20px]，弧凸左上）
  const corner = await window.evaluate(() => {
    const el = document.querySelector('.rounded-tl-\\[20px\\]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log('=== 圆角块 ===', JSON.stringify(corner));
  expect(corner).not.toBeNull();
  expect(corner!.w).toBe(20);
  expect(corner!.h).toBe(20);

  // 截图人工查看
  const shot = join(__dirname, '..', '..', 'test-results', 'corner-radius.png');
  await window.screenshot({ path: shot });
  console.log('=== 截图已保存: ' + shot);

  await electronApp.close();
});
