/**
 * 验证：网页区左上角 10px 圆角（BrowserView 角盖方案）
 * 导航外部网页后截图网页区左上角，人工确认圆弧
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

test('网页区左上角圆角截图', async () => {
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
  // （角盖 BrowserView 的 data: URL 页面也会被 Playwright 视作 window，不能 firstWindow）
  let window: Page | null = null;
  for (let i = 0; i < 20 && !window; i++) {
    await electronApp.waitForEvent('window', { timeout: 5000 }).catch(() => undefined);
    window =
      electronApp.windows().find((p) => p.url().includes('dist/renderer/index.html')) ?? null;
  }
  if (!window) throw new Error('主窗口未找到');
  await window.waitForLoadState('domcontentloaded');
  // 生产模式 React 首帧渲染较慢，固定等待后操作
  await window.waitForTimeout(4000);

  // 展开右侧栏（默认折叠）后导航外部网页
  await window.locator('[aria-label="右侧边栏"]').first().dblclick();
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  const omniboxInput = window.getByRole('textbox').first();
  await omniboxInput.fill('https://example.com');
  await omniboxInput.press('Enter');
  await expect(window.getByText('Example Domain')).toBeVisible({ timeout: 15_000 });

  // 等角盖视图加载完成（loadURL 异步）
  await window.waitForTimeout(2000);

  // 程序化断言：主窗口存在 2 个 BrowserView（网页 view + 角盖 view），
  // 角盖 bounds 位于网页区左上角（x=leftWidth, y=0, 20x20），
  // 角盖 HTML 含右下 10px 圆弧样式（圆心在网页区左上角内）
  const cornerInfo = await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return { viewCount: 0, views: [] as { bounds: unknown; url: string }[] };
    const views = win.getBrowserViews();
    return {
      viewCount: views.length,
      views: views.map((v) => ({
        bounds: v.getBounds(),
        url: v.webContents.getURL(),
      })),
    };
  });
  console.log('=== 角盖信息 ===', JSON.stringify(cornerInfo, null, 2));
  const mask = cornerInfo.views.find((v) => v.url.startsWith('data:text/html'));
  if (!mask) throw new Error('角盖 BrowserView 未创建');
  expect(mask.bounds).toEqual({ x: 44, y: 0, width: 20, height: 20 });
  // data: URL 中空格被编码为 %20，样式为 border-radius:0 0 10px 0（右下弧）
  expect(mask.url).toContain('border-radius:0%200%2010px%200');

  // 截图整个窗口（左上角含圆角）
  const shot = join(__dirname, '..', '..', 'test-results', 'corner-radius.png');
  await window.screenshot({ path: shot });
  console.log('=== 截图已保存: ' + shot);

  await electronApp.close();
});
