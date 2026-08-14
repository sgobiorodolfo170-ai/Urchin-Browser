/**
 * 复现：新建标签后，被顶下去的旧标签在右侧栏是否保持原状态（标题/URL）
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

async function launchApp(): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-repro-'));

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
  // 右侧栏默认折叠，双击右侧边栏空白处展开（折叠/展开按钮已移除）
  await window.locator('[aria-label="右侧边栏"]').first().dblclick();
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });

  return { electronApp, window };
}

test('新建标签后旧标签保持原状态且置顶新标签', async () => {
  const { electronApp, window } = await launchApp();

  // 1. 地址栏导航 example.com（当前标签内导航）
  const omniboxInput = window.getByRole('textbox').first();
  await omniboxInput.fill('https://example.com');
  await omniboxInput.press('Enter');
  await expect(omniboxInput).toHaveValue(/example\.com/, { timeout: 15_000 });

  // 等待右侧栏标签显示页面标题
  await expect(window.getByText('Example Domain')).toBeVisible({ timeout: 15_000 });

  // 2. 新建标签
  await window.getByRole('button', { name: '新建标签' }).click();

  // 3. 等待标签数 = 2
  await expect(window.locator('[aria-label="关闭标签"]')).toHaveCount(2, { timeout: 10_000 });

  // 3.5 新标签标题应最终同步为"新标签页"（而非 URL）
  await expect(window.getByText('新标签页')).toBeVisible({ timeout: 10_000 });

  // 4. 断言：两个标签的显示文本（标签标题 span：flex-1 truncate）
  const tabTitles = await window
    .locator('[aria-label="右侧边栏"] span.flex-1.truncate')
    .allTextContents();
  console.log('=== 右侧栏标签文本 ===', JSON.stringify(tabTitles));

  // 旧标签（example.com）应保持"Example Domain"，不得变成"新标签页"
  expect(tabTitles.some((t) => t.includes('Example Domain'))).toBeTruthy();
  expect(tabTitles.some((t) => t.includes('新标签页'))).toBeTruthy();

  // 5. 新标签置顶：第一个标签是新标签页
  expect(tabTitles[0]?.includes('新标签页')).toBeTruthy();

  await electronApp.close();
});
