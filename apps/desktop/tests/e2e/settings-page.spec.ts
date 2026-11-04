/**
 * 设置页 E2E 冒烟（refactor-plan-p2 §Session3 必跑清单所列
 * settings-page-component 的落地；此前该页无任何 E2E 覆盖）
 *
 * 覆盖：左侧栏入口 → 页面渲染 → 选项卡切换 → 字段变更自动保存（toast）。
 * 数据目录与 userData 均隔离到临时目录（设置值存共享设置库，不隔离会
 * 污染用户真实设置/用例互污，见 workspaces.spec 同款注释）。
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-settings-e2e-'));

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

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window };
}

test.describe('设置页', () => {
  test('should render tabs, switch between them and auto-save a toggle', async () => {
    const { electronApp, window } = await launchApp();

    // 左侧栏「设置」入口 → 打开设置页（默认通用 tab）
    await window.getByRole('button', { name: '设置', exact: true }).click();
    await expect(window.getByRole('heading', { name: '通用' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.getByText('界面语言')).toBeVisible();

    // 选项卡切换：剪藏（含固定保存位置说明）/ 隐私与安全
    await window.getByRole('button', { name: '剪藏', exact: true }).click();
    await expect(window.getByRole('heading', { name: '剪藏' })).toBeVisible();
    await expect(window.getByText('默认保存格式')).toBeVisible();

    await window.getByRole('button', { name: '隐私与安全', exact: true }).click();
    await expect(window.getByRole('heading', { name: '隐私与安全' })).toBeVisible();

    // 切换开关 → debounce 800ms 自动保存 → 「已保存」toast
    // （FieldControl 的开关无 aria-label，按行内 label 文本定位）
    const trackerRow = window
      .locator('div.flex.items-center.justify-between')
      .filter({ hasText: '拦截追踪器' });
    const trackerToggle = trackerRow.getByRole('switch');
    await expect(trackerToggle).toBeVisible();
    const before = await trackerToggle.getAttribute('aria-checked');
    await trackerToggle.click();
    await expect(window.getByText('已保存')).toBeVisible({ timeout: 5_000 });
    await expect(trackerToggle).toHaveAttribute(
      'aria-checked',
      before === 'true' ? 'false' : 'true',
    );

    await electronApp.close();
  });
});
