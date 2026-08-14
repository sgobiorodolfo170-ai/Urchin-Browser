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
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });

  // 等待第一个窗口出现
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');

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
  test('启动 Electron 并显示主窗口', async () => {
    const { electronApp, window } = await launchApp();

    // 验证窗口标题
    await expect(window).toHaveTitle(/Urchin Browser/i);

    // 验证根容器渲染
    await expect(window.locator('#root')).toBeVisible();

    // 验证 Tab Bar 渲染（新建标签按钮存在）
    await expect(window.getByRole('button', { name: '新建标签' })).toBeVisible({
      timeout: 15_000,
    });

    await electronApp.close();
  });

  test('新建标签', async () => {
    const { electronApp, window } = await launchApp();

    // 初始标签数量
    const initialTabs = await window.locator('[aria-label="关闭标签"]').count();

    // 点击新建标签按钮
    await window.getByRole('button', { name: '新建标签' }).click();

    // 等待新标签出现（关闭按钮数量增加）
    await expect(window.locator('[aria-label="关闭标签"]')).toHaveCount(initialTabs + 1, {
      timeout: 10_000,
    });

    await electronApp.close();
  });

  test('导航到 URL', async () => {
    const { electronApp, window } = await launchApp();

    // 等待应用就绪
    await expect(window.getByRole('button', { name: '新建标签' })).toBeVisible({
      timeout: 15_000,
    });

    // 在地址栏输入 URL 并提交
    const omniboxInput = window.getByRole('textbox').first();
    await omniboxInput.fill('https://example.com');
    await omniboxInput.press('Enter');

    // 验证地址栏更新为新 URL（等待导航完成）
    await expect(omniboxInput).toHaveValue(/example\.com/, { timeout: 15_000 });

    await electronApp.close();
  });

  test('关闭标签', async () => {
    const { electronApp, window } = await launchApp();

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

    await electronApp.close();
  });
});
