/**
 * M27 笔记 / 便利贴 E2E
 *
 * 覆盖：左侧栏入口 → 三区渲染 → 新建笔记 → 任务清单 → 便利贴。
 * 数据目录隔离到临时目录，避免污染本机真实笔记。
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-notebook-e2e-'));

  const electronApp = await electron.launch({
    cwd: appPath,
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYWRIGHT: '1',
      URCHIN_TEST_USER_DATA: userDataDir,
      // 数据目录也隔离到临时目录：笔记状态（notebook.state）存在共享设置库中，
      // 不隔离则上次运行打开的笔记（activeNoteId）会让「新建笔记」按钮隐藏，
      // 用例互污（见 workspaces.spec 同款注释）。
      URCHIN_TEST_DATA_DIR: join(userDataDir, 'data'),
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window };
}

test.describe('M27 笔记 / 便利贴', () => {
  test('should open notebook page and edit note/task/sticky', async () => {
    const { electronApp, window } = await launchApp();

    await window.getByRole('button', { name: '笔记', exact: true }).click();

    // 三区渲染：左区导航、中区笔记、右区便利贴画布
    await expect(window.getByLabel('笔记导航')).toBeVisible({ timeout: 15_000 });
    await expect(window.getByLabel('笔记内容')).toBeVisible();
    await expect(window.getByLabel('便利贴画布')).toBeVisible();
    await expect(window.getByText('我的笔记本').first()).toBeVisible();

    // 新建笔记并写入标题
    await window.getByRole('button', { name: '新建笔记', exact: true }).click();
    const title = window.getByLabel('笔记标题');
    await title.fill('E2E 新建笔记');
    await expect(title).toHaveValue('E2E 新建笔记');

    // 任务清单
    await window.getByLabel('切换到任务清单').click();
    const taskInput = window.getByPlaceholder('添加任务后按 Enter');
    await taskInput.fill('E2E 任务');
    await taskInput.press('Enter');
    await expect(window.getByText('E2E 任务')).toBeVisible();
    await window.getByLabel('标记为已完成').click();
    await expect(window.getByLabel('标记为未完成')).toBeVisible();

    // 便利贴：新建 + 编辑文本
    await window.getByLabel('新建便利贴').click();
    const stickyText = window.getByLabel('便利贴内容');
    await stickyText.fill('E2E 便利贴内容');
    await expect(stickyText).toHaveValue('E2E 便利贴内容');

    await electronApp.close();
  });
});
