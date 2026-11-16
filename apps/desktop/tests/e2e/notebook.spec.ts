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

async function launchApp(
  profile?: string,
): Promise<{ electronApp: ElectronApplication; window: Page; userDataDir: string }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = profile ?? mkdtempSync(join(tmpdir(), 'urchin-notebook-e2e-'));

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

  await electronApp.firstWindow();
  let window: Page | undefined;
  await expect
    .poll(
      async () => {
        window = electronApp
          .windows()
          .find(
            (page) => page.url().startsWith('file:') && page.url().includes('/renderer/index.html'),
          );
        return Boolean(
          window && (await window.getByRole('button', { name: '速记', exact: true }).count()),
        );
      },
      { timeout: 20000 },
    )
    .toBe(true);
  if (!window) throw new Error('未找到应用主窗口');
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window, userDataDir };
}

test.describe('M27 笔记 / 便利贴', () => {
  test('calendar P1 calendars, recurrence, views, links, backup recovery and reminders', async () => {
    test.setTimeout(120_000);
    const { electronApp, window } = await launchApp();
    try {
      await window.getByRole('button', { name: '速记', exact: true }).click();
      await window.getByRole('button', { name: '新建笔记', exact: true }).click();
      await window.getByLabel('笔记标题').fill('关联笔记');
      await window.getByRole('button', { name: '打开日历', exact: true }).click();
      const calendar = window.getByRole('dialog', { name: '日历', exact: true });
      await calendar.getByText('日历管理、筛选与备份', { exact: true }).click();
      await calendar.getByRole('button', { name: '新建日历', exact: true }).click();
      await calendar.getByLabel('日历名称', { exact: true }).fill('个人测试');
      await calendar
        .getByRole('form', { name: '日历管理表单' })
        .getByLabel('默认日历', { exact: true })
        .check();
      await calendar.getByRole('button', { name: '保存日历', exact: true }).click();
      await expect(calendar.getByRole('form', { name: '日历管理表单' })).toHaveCount(0);
      await calendar.getByRole('button', { name: '新建日程', exact: true }).click();
      await calendar.getByLabel('日程标题', { exact: true }).fill('P1 重复日程');
      await expect(
        calendar.getByLabel('所属日历', { exact: true }).locator('option:checked'),
      ).toHaveText('个人测试');
      await calendar.getByLabel('重复频率', { exact: true }).selectOption('daily');
      await calendar.getByLabel('重复次数', { exact: true }).fill('3');
      await calendar
        .getByLabel('关联速记对象', { exact: true })
        .selectOption({ label: '笔记：关联笔记' });
      await calendar.getByRole('button', { name: '保存日程', exact: true }).click();
      await expect(
        calendar.locator('article').getByText('P1 重复日程', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: '周视图', exact: true }).click();
      await expect(calendar.getByRole('region', { name: '周视图', exact: true })).toBeVisible();
      await window.screenshot({
        path: resolve(__dirname, '..', '..', 'test-results', 'calendar-week.png'),
      });
      await calendar.getByRole('button', { name: '日视图', exact: true }).click();
      await expect(calendar.getByRole('region', { name: '日视图', exact: true })).toBeVisible();
      await calendar.getByRole('button', { name: '月视图', exact: true }).click();
      await window.screenshot({
        path: resolve(__dirname, '..', '..', 'test-results', 'calendar-month.png'),
      });
      await calendar.getByRole('button', { name: '编辑日程', exact: true }).click();
      await calendar.getByLabel('日程标题', { exact: true }).fill('P1 单次修改');
      await calendar.getByRole('button', { name: '保存日程', exact: true }).click();
      await expect(
        calendar.locator('article').getByText('P1 单次修改', { exact: true }),
      ).toBeVisible();
      const dateLabels = await window.evaluate(() =>
        Array.from({ length: 3 }, (_, offset) => {
          const date = new Date();
          date.setDate(date.getDate() + offset);
          return date.toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          });
        }),
      );
      await calendar.getByRole('button', { name: dateLabels[1]!, exact: true }).click();
      await calendar.getByRole('button', { name: '编辑日程', exact: true }).click();
      await calendar.getByLabel('修改范围', { exact: true }).selectOption('future');
      await calendar.getByLabel('日程标题', { exact: true }).fill('P1 此后修改');
      await calendar.getByRole('button', { name: '保存日程', exact: true }).click();
      await expect(
        calendar.locator('article').getByText('P1 此后修改', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: '编辑日程', exact: true }).click();
      await calendar.getByLabel('修改范围', { exact: true }).selectOption('series');
      await calendar.getByLabel('日程标题', { exact: true }).fill('P1 系列修改');
      await calendar.getByRole('button', { name: '保存日程', exact: true }).click();
      await expect(
        calendar.locator('article').getByText('P1 系列修改', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: dateLabels[2]!, exact: true }).click();
      await calendar.getByRole('button', { name: '删除日程', exact: true }).click();
      await calendar.getByLabel('删除范围', { exact: true }).selectOption('future');
      await calendar.getByRole('button', { name: '确认删除', exact: true }).click();
      await expect(calendar.locator('article')).toHaveCount(0);
      await calendar.getByLabel('已删除', { exact: true }).check();
      await calendar.getByRole('button', { name: '恢复日程', exact: true }).click();
      await calendar.getByLabel('已删除', { exact: true }).uncheck();
      await expect(
        calendar.locator('article').getByText('P1 系列修改', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: '删除日程', exact: true }).click();
      await calendar.getByLabel('删除范围', { exact: true }).selectOption('series');
      await calendar.getByRole('button', { name: '确认删除', exact: true }).click();
      await calendar.getByLabel('已删除', { exact: true }).check();
      await calendar.getByRole('button', { name: '恢复日程', exact: true }).click();
      await calendar.getByLabel('已删除', { exact: true }).uncheck();
      await calendar.getByRole('button', { name: dateLabels[0]!, exact: true }).click();
      await expect(
        calendar.locator('article').getByText('P1 单次修改', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: '删除日程', exact: true }).click();
      await calendar.getByRole('button', { name: '确认删除', exact: true }).click();
      await calendar.getByLabel('已删除', { exact: true }).check();
      await calendar.getByRole('button', { name: '恢复日程', exact: true }).click();
      await calendar.getByLabel('已删除', { exact: true }).uncheck();
      await expect(
        calendar.locator('article').getByText('P1 单次修改', { exact: true }),
      ).toBeVisible();
      const backup = (await window.evaluate(
        async () => await globalThis.window.urchin.invoke('calendar.exportBackup', {}),
      )) as { data: string };
      await calendar.getByRole('button', { name: '编辑日程', exact: true }).click();
      await calendar.getByLabel('日程标题', { exact: true }).fill('备份后修改');
      await calendar.getByRole('button', { name: '保存日程', exact: true }).click();
      await expect(
        calendar.locator('article').getByText('备份后修改', { exact: true }),
      ).toBeVisible();
      await calendar.getByLabel('导入日历备份', { exact: true }).setInputFiles({
        name: 'calendar.json',
        mimeType: 'application/json',
        buffer: Buffer.from(backup.data),
      });
      await calendar
        .getByRole('alertdialog', { name: '恢复日历备份', exact: true })
        .getByRole('button', { name: '恢复备份', exact: true })
        .click();
      await expect(
        calendar.locator('article').getByText('P1 单次修改', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: '撤销上次恢复', exact: true }).click();
      await calendar
        .getByRole('alertdialog', { name: '恢复日历备份', exact: true })
        .getByRole('button', { name: '恢复备份', exact: true })
        .click();
      await expect(
        calendar.locator('article').getByText('备份后修改', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: '管理日历 我的日历', exact: true }).click();
      await calendar
        .getByRole('form', { name: '日历管理表单' })
        .getByLabel('默认日历', { exact: true })
        .check();
      await calendar.getByRole('button', { name: '保存日历', exact: true }).click();
      await expect(calendar.getByRole('form', { name: '日历管理表单' })).toHaveCount(0);
      await calendar.getByRole('button', { name: '管理日历 个人测试', exact: true }).click();
      await calendar.getByLabel('启用日历', { exact: true }).uncheck();
      await calendar.getByRole('button', { name: '保存日历', exact: true }).click();
      await expect(calendar.locator('article')).toHaveCount(0);
      await calendar.getByLabel('显示日历 个人测试', { exact: true }).check();
      await expect(
        calendar.locator('article').getByText('备份后修改', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: '打开关联笔记：关联笔记', exact: true }).click();
      await expect(calendar).toHaveCount(0);
      await expect(window.getByLabel('笔记标题')).toHaveValue('关联笔记');
      await window.evaluate(async () => {
        const now = Date.now();
        await globalThis.window.urchin.invoke('calendar.createEvent', {
          idempotencyKey: crypto.randomUUID(),
          event: {
            calendarId: 'local-default',
            title: 'P1 实时提醒',
            startAt: new Date(now - 1000).toISOString(),
            endAt: new Date(now + 3600000).toISOString(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            reminders: [{ method: 'in_app', minutesBefore: 0 }],
          },
        });
      });
      const toast = window.getByRole('complementary', { name: '日历提醒', exact: true });
      await expect(toast.getByText('P1 实时提醒', { exact: true })).toBeVisible({ timeout: 20000 });
      await toast.getByRole('button', { name: '关闭提醒 P1 实时提醒', exact: true }).click();
      await expect(toast).toHaveCount(0);
    } finally {
      await electronApp.close();
    }
  });
  test('calendar CRUD, unsaved protection and restart persistence', async () => {
    let app = await launchApp();
    try {
      let window = app.window;
      await window.getByRole('button', { name: '速记', exact: true }).click();
      await window.getByRole('button', { name: '打开日历', exact: true }).click();
      let calendar = window.getByRole('dialog', { name: '日历', exact: true });
      await calendar.getByRole('button', { name: '新建日程', exact: true }).click();
      await calendar.getByLabel('日程标题', { exact: true }).fill('日历持久化测试');
      await calendar.getByRole('button', { name: '关闭日历', exact: true }).click();
      await expect(calendar.getByRole('alertdialog', { name: '未保存的日程' })).toBeVisible();
      await calendar.getByRole('button', { name: '继续保留', exact: true }).click();
      await calendar.getByRole('button', { name: '保存日程', exact: true }).click();
      await expect(calendar.getByRole('form', { name: '日程编辑' })).toHaveCount(0);
      await expect(
        calendar.locator('article').getByText('日历持久化测试', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: '编辑日程', exact: true }).click();
      await calendar.getByLabel('日程标题', { exact: true }).fill('日历修改完成');
      await calendar.getByRole('button', { name: '保存日程', exact: true }).click();
      await expect(
        calendar.locator('article').getByText('日历修改完成', { exact: true }),
      ).toBeVisible();
      await app.electronApp.close();
      app = await launchApp(app.userDataDir);
      window = app.window;
      await window.getByRole('button', { name: '速记', exact: true }).click();
      await window.getByRole('button', { name: '打开日历', exact: true }).click();
      calendar = window.getByRole('dialog', { name: '日历', exact: true });
      await expect(
        calendar.locator('article').getByText('日历修改完成', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: '议程', exact: true }).click();
      await expect(calendar.getByRole('region', { name: '议程列表' })).toBeVisible();
      await calendar.getByRole('button', { name: '删除日程', exact: true }).click();
      await calendar.getByRole('button', { name: '确认删除', exact: true }).click();
      await expect(calendar.locator('article')).toHaveCount(0);
      await calendar.getByLabel('已删除', { exact: true }).check();
      await calendar.getByRole('button', { name: '恢复日程', exact: true }).click();
      await calendar.getByLabel('已删除', { exact: true }).uncheck();
      await expect(
        calendar.locator('article').getByText('日历修改完成', { exact: true }),
      ).toBeVisible();
      await calendar.getByRole('button', { name: '新建日程', exact: true }).click();
      await calendar.getByLabel('日程标题', { exact: true }).fill('跨天假期');
      await calendar.getByLabel('全天', { exact: true }).check();
      const firstDate = await calendar.getByLabel('开始日期', { exact: true }).inputValue();
      const lastDate = new Date(`${firstDate}T00:00:00Z`);
      lastDate.setUTCDate(lastDate.getUTCDate() + 2);
      await calendar
        .getByLabel('结束日期（不含）', { exact: true })
        .fill(lastDate.toISOString().slice(0, 10));
      await calendar.getByRole('button', { name: '保存日程', exact: true }).click();
      // 与已有定时日程重叠：明确确认后才保存。
      await expect(calendar.getByRole('alert')).toContainText('时间重叠');
      await calendar.getByRole('button', { name: '保存日程', exact: true }).click();
      await expect(
        calendar.locator('article').getByText('跨天假期', { exact: true }),
      ).toBeVisible();
    } finally {
      await app.electronApp.close();
    }
  });
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
    await expect(calendar.locator('[aria-selected="true"]')).toHaveCount(1);
    await calendar.getByRole('button', { name: '下个月', exact: true }).click();
    await calendar.getByRole('button', { name: '今天', exact: true }).click();
    await expect(calendar.locator('[aria-current="date"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
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
