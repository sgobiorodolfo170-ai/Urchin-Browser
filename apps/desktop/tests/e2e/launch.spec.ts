/**
 * E2E 测试：v0.1 关键路径
 * 依据：07-立项准备 §2.6 D5 / 05-路线图 v0.1 验收 / ADR-008 W6
 *
 * 覆盖路径：
 * 1. 启动 Electron 并显示主窗口
 * 2. 新建标签
 * 3. 导航到 URL
 * 4. 关闭标签
 *
 * 注意：AI 摘要路径依赖真实 Provider + API key，v0.1 E2E 暂不覆盖，
 * 由单元测试（provider-e2e.test.ts）验证 Orchestrator ↔ Provider SDK 集成。
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
import { getOmniboxPage, getStatusBarPage, setMainWindowSize } from './helpers/status-bar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 启动 Electron 应用并返回 Playwright 页面 */
async function launchApp(): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-'));

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

  // 等待第一个窗口出现
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  // 与 CI runner 同尺寸（1024×720）：布局类回归只在窄窗口复现
  await setMainWindowSize(electronApp);

  // W7+ UI：标签列表在右侧栏内，默认折叠为图标条。
  // E2E 关键路径依赖「新建标签」按钮，先展开右侧栏暴露标签操作区。
  // 折叠/展开按钮已移除，双击右侧边栏空白处展开。
  await window.locator('[aria-label="右侧边栏"]').first().dblclick();
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });

  return { electronApp, window };
}

test.describe('v0.1 关键路径', () => {
  // 每个用例用 try/finally 收口 Electron 实例：断言失败时若不 close，进程会留在 worker 里
  // 占满 CPU/内存，把同一 worker 的后续用例拖成超时（2026-11-09 CI：前一个用例 30s 失败后，
  // 下一个用例连 [aria-label="右侧边栏"] 都点不到）。
  test('启动 Electron 并显示主窗口', async () => {
    const { electronApp, window } = await launchApp();
    try {
      // 验证窗口标题（按 locale 显示中文「顽童浏览器」或英文「Urchin Browser」）
      await expect(window).toHaveTitle(/Urchin Browser|顽童浏览器/i);

      // 验证根容器渲染
      await expect(window.locator('#root')).toBeVisible();

      // 验证 Tab Bar 渲染（新建标签按钮存在）
      await expect(window.getByRole('button', { name: '新建标签' })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await electronApp.close();
    }
  });

  test('新建标签', async () => {
    const { electronApp, window } = await launchApp();
    try {
      // 初始标签数量
      const initialTabs = await window.locator('[aria-label="关闭标签"]').count();

      // 点击新建标签按钮
      await window.getByRole('button', { name: '新建标签' }).click();

      // 等待新标签出现（关闭按钮数量增加）
      await expect(window.locator('[aria-label="关闭标签"]')).toHaveCount(initialTabs + 1, {
        timeout: 10_000,
      });
    } finally {
      await electronApp.close();
    }
  });

  test('导航到 URL', async () => {
    const { electronApp, window } = await launchApp();
    try {
      // 等待应用就绪
      await expect(window.getByRole('button', { name: '新建标签' })).toBeVisible({
        timeout: 15_000,
      });

      // 在地址栏输入 URL 并提交（内部页地址栏在主窗口；导航到外部页后状态栏悬浮层出现）
      const omniboxPage = await getOmniboxPage(electronApp, window);
      const omniboxInput = omniboxPage.getByRole('textbox', { name: '地址栏' });
      await omniboxInput.fill('https://example.com');
      await omniboxInput.press('Enter');

      // 验证地址栏更新为新 URL（导航完成后悬浮层地址栏显示新 URL）
      const statusBar = await getStatusBarPage(electronApp);
      await expect(statusBar.getByRole('textbox', { name: '地址栏' })).toHaveValue(/example\.com/, {
        timeout: 15_000,
      });
    } finally {
      await electronApp.close();
    }
  });

  test('关闭标签', async () => {
    const { electronApp, window } = await launchApp();
    try {
      // 等待应用就绪
      await expect(window.getByRole('button', { name: '新建标签' })).toBeVisible({
        timeout: 15_000,
      });

      // 先新建一个标签确保至少有 2 个标签（关闭后仍剩 1 个）
      await window.getByRole('button', { name: '新建标签' }).click();
      await expect(window.locator('[aria-label="关闭标签"]')).toHaveCount(2, {
        timeout: 10_000,
      });

      // 关闭第二个标签
      const closeButtons = window.locator('[aria-label="关闭标签"]');
      await closeButtons.nth(1).click();

      // 验证标签数量减少
      await expect(window.locator('[aria-label="关闭标签"]')).toHaveCount(1, {
        timeout: 10_000,
      });
    } finally {
      await electronApp.close();
    }
  });
});

test('地址栏原生粘贴并转到菜单确实发出导航', async () => {
  const { electronApp } = await launchApp();
  try {
    const bar = await getStatusBarPage(electronApp);
    await bar.getByRole('textbox', { name: '地址栏' }).click();
    // 触发实际 context-menu 监听器，并执行实际菜单项的回调；避免测试操作系统菜单坐标。
    await electronApp.evaluate(({ BrowserWindow, Menu, clipboard }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Urchin Status Bar');
      if (!win) throw new Error('status bar missing');
      win.focus();
      const original = Menu.buildFromTemplate;
      const previousClipboard = clipboard.readText();
      clipboard.writeText('https://example.com/paste-go-regression');
      Menu.buildFromTemplate = (template) => {
        const item = template.find((entry) => entry.label?.startsWith('粘贴并转到'));
        if (!item || typeof item.click !== 'function') throw new Error('paste-and-go missing');
        const menu = original(template);
        item.click(menu.items[0]!, win, { triggeredByAccelerator: false });
        menu.popup = () => {
          /* 不打开 OS 菜单，直接执行原生菜单回调。 */
        };
        return menu;
      };
      try {
        win.webContents.emit(
          'context-menu',
          {},
          { isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true } },
        );
      } finally {
        Menu.buildFromTemplate = original;
        clipboard.writeText(previousClipboard);
      }
    });
    await expect
      .poll(async () => bar.getByRole('textbox', { name: '地址栏' }).inputValue())
      .toContain('example.com/paste-go-regression');
  } finally {
    await electronApp.close();
  }
});

test('截图覆盖整个显示器，窗口预选与背景保持相同坐标', async () => {
  const { electronApp } = await launchApp();
  try {
    const bar = await getStatusBarPage(electronApp);
    await bar.evaluate(() => window.urchin.invoke('screenshot.capture', {}));
    const capture = electronApp.windows().find((p) => p.url().includes('capture-overlay'));
    if (!capture) throw new Error('capture overlay missing');
    const display = await electronApp.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    const viewport = await capture.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(viewport).toEqual({ width: display.width, height: display.height });
    const image = await capture
      .locator('#screen')
      .evaluate((el: HTMLImageElement) => ({ width: el.naturalWidth, height: el.naturalHeight }));
    expect(image.width / image.height).toBeCloseTo(viewport.width / viewport.height, 3);
  } finally {
    await electronApp.close();
  }
});
