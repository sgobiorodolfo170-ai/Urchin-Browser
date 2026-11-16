import { test, electron } from './helpers/electron-test';
/**
 * M27 笔记 / 便利贴 E2E
 *
 * 覆盖：左侧栏入口 → 三区渲染 → 新建笔记 → 任务清单 → 便利贴。
 * 数据目录隔离到临时目录，避免污染本机真实笔记。
 */
import { expect, type ElectronApplication, type Page } from '@playwright/test';
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

    await window.getByRole('button', { name: '速记', exact: true }).click();

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

    // 日历覆盖打开，不重挂载笔记现场；Esc 关闭后恢复入口焦点。
    const calendarEntry = window.getByRole('button', { name: '打开日历', exact: true });
    const addNotebook = window.getByRole('button', { name: '新建笔记本', exact: true });
    expect((await calendarEntry.boundingBox())!.x).toBeLessThan(
      (await addNotebook.boundingBox())!.x,
    );
    await calendarEntry.click();
    const calendar = window.getByRole('dialog', { name: '日历', exact: true });
    await expect(calendar).toBeVisible();
    await expect(calendar.getByRole('button', { pressed: true })).toHaveCount(1);
    await calendar.getByRole('button', { name: '下个月', exact: true }).click();
    await calendar.getByRole('button', { name: '今天', exact: true }).click();
    await expect(calendar.locator('[aria-current="date"]')).toHaveAttribute('aria-pressed', 'true');
    await calendar.press('Escape');
    await expect(calendar).toHaveCount(0);
    await expect(calendarEntry).toBeFocused();
    await expect(title).toHaveValue('E2E 新建笔记');
    await calendarEntry.click();
    await calendar.getByRole('button', { name: '关闭日历', exact: true }).click();
    await expect(calendar).toHaveCount(0);

    const body = window.getByLabel('笔记正文');
    const source = '## 本周计划\n\n优先完成编辑器\n\n- [ ] 阅读体验';
    await body.fill(source);
    await body.evaluate((element: HTMLTextAreaElement) => {
      const start = element.value.indexOf('编辑器');
      element.setSelectionRange(start, start + 3);
    });
    await window.getByRole('button', { name: '加粗', exact: true }).click();
    await expect(body).toHaveValue(source.replace('编辑器', '**编辑器**'));
    // 格式操作与键盘输入共用 Chromium 原生撤销栈。
    await body.press('ControlOrMeta+z');
    await expect(body).toHaveValue(source);
    await body.press('ControlOrMeta+Shift+z');
    await expect(body).toHaveValue(source.replace('编辑器', '**编辑器**'));

    await window.getByRole('button', { name: '阅读笔记' }).click();
    const reading = window.getByRole('region', { name: '笔记阅读' });
    await expect(reading.getByRole('heading', { name: '本周计划' })).toBeVisible();
    await expect(reading.locator('strong')).toHaveText('编辑器');
    await window.getByRole('button', { name: '增大正文字号' }).click();
    await expect(reading.locator('.notebook-note-preview')).toHaveCSS('font-size', '18px');
    await window.getByRole('button', { name: '编辑笔记' }).click();
    await expect(body).toHaveValue(source.replace('编辑器', '**编辑器**'));
    await body.press('ControlOrMeta+z');
    await expect(body).toHaveValue(source);
    await body.press('ControlOrMeta+Shift+z');
    await expect(body).toHaveValue(source.replace('编辑器', '**编辑器**'));

    await expect
      .poll(async () => {
        const result = (await window.evaluate(async () => {
          return globalThis.window.urchin.invoke('settings.get', { key: 'notebook.state' });
        })) as { value?: { notes?: { title: string; content: string }[] } };
        return result.value?.notes?.find((note) => note.title === 'E2E 新建笔记')?.content;
      })
      .toBe(source.replace('编辑器', '**编辑器**'));

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
