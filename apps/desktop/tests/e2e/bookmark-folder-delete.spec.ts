/**
 * E2E 回归：收藏夹面板文件夹删除（用户报告：收藏夹选项卡下添加的文件夹无法删除）
 *
 * 根因（2026-11-06）：文件夹删除原经原生 window.confirm 确认，而面板是
 * 「blur 即销毁」的独立子窗口——原生确认对话框弹出时夺走窗口焦点触发 blur，
 * 面板被 destroy，渲染进程死亡，bookmark.delete 永远发不出去（书签行走星标
 * 无 confirm 所以能删，文件夹行只有删除走 confirm 所以不能删）。
 *
 * 修复：面板内 React 确认框替代原生 confirm（无焦点切换、无 blur）。
 *
 * 验证信号（可机器判定）：
 * 1. 新建文件夹成功（行出现）
 * 2. 点击行内 ✕ → 面板内确认框出现，面板窗口不被销毁
 * 3. 点击确认「删除」→ 文件夹行消失
 * 4. 主进程状态同步：bookmark.list 中不再存在该文件夹
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
import { getStatusBarPage, waitForShellReady } from './helpers/status-bar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function launchApp(): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-folder-del-'));

  const electronApp = await electron.launch({
    cwd: appPath,
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYWRIGHT: '1',
      // 双变量配对隔离（与其他 spec 一致）：URCHIN_TEST_USER_DATA 隔离 userData，
      // URCHIN_TEST_DATA_DIR 隔离 DD1 数据目录（书签库）——只设前者时书签仍会
      // 写进开发模式默认数据目录 apps/desktop/data（2026-11-06 曾因此污染共享库）
      URCHIN_TEST_USER_DATA: userDataDir,
      URCHIN_TEST_DATA_DIR: join(userDataDir, 'data'),
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  // 壳就绪后再找悬浮层：悬浮层由渲染层首帧后的 ui.statusbar.sync 懒创建（见 helper 注释）
  await waitForShellReady(window);
  return { electronApp, window };
}

/** 定位收藏夹面板页面（panel.html），带轮询（页面注册晚于原生窗口创建，见 visibility spec） */
async function findPanelWindow(electronApp: ElectronApplication): Promise<Page> {
  let panelWindow: Page | undefined;
  await expect
    .poll(
      () => {
        panelWindow = electronApp.windows().find((w) => w.url().includes('panel.html'));
        return Boolean(panelWindow);
      },
      { timeout: 15_000, message: '面板窗口（panel.html）应出现在 Playwright 页面列表' },
    )
    .toBe(true);
  await panelWindow!.waitForLoadState('domcontentloaded');
  return panelWindow!;
}

test('收藏夹面板：新建文件夹可在面板内确认后删除', async () => {
  const { electronApp, window } = await launchApp();

  try {
    // 1. 点击状态栏收藏夹按钮 → 弹出面板（normal 模式）
    // 冷启动首跑（CI 干净环境 + AV 扫描）状态栏悬浮窗创建可能晚于默认 15s：
    // 2026-11-10 CI 实测该行超时 1 次（重试后绿），故显式给 30s 就绪轮询预算。
    const statusBar = await getStatusBarPage(electronApp, 30_000);
    await statusBar.getByLabel('收藏夹').click();
    const panelWindow = await findPanelWindow(electronApp);

    // 诊断守卫：若仍有任何 JS 原生对话框（不应有），记日志并自动关闭，避免测试挂死
    panelWindow.on('dialog', (d) => {
      console.log('[folder-delete-debug] unexpected native dialog:', d.message());
      void d.dismiss().catch(() => {
        /* 面板可能已销毁 */
      });
    });

    // 2. 新建文件夹「E2E删除测试」（＋ 文件夹 → 输入 → Enter）
    await panelWindow.getByTitle('新建文件夹').click();
    const newFolderInput = panelWindow.locator('.new-folder-input');
    await expect(newFolderInput).toBeVisible();
    await newFolderInput.fill('E2E删除测试');
    await newFolderInput.press('Enter');
    const folderRow = panelWindow.locator('.folder-item', { hasText: 'E2E删除测试' });
    await expect(folderRow).toBeVisible({ timeout: 5_000 });

    // 3. 点击行内 ✕（删除）→ 面板内确认框出现（不是原生对话框）
    await folderRow.getByTitle('删除').click();
    const confirmDialog = panelWindow.locator('.confirm-dialog');
    // 面板窗口若在此处被销毁（回归：原生 confirm 触发 blur 关面板），本断言失败
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText('删除文件夹「E2E删除测试」及其全部内容');

    // 4. 点击确认「删除」→ 文件夹行消失，面板仍存活
    await confirmDialog.getByRole('button', { name: '删除' }).click();
    await expect(folderRow).toHaveCount(0);
    // 根目录面包屑仅显示 ⌂ 图标（2026-11-07 起，原「⌂ 收藏夹」文字已移除）
    await expect(panelWindow.locator('.crumb-home')).toHaveText('⌂');

    // 5. 主进程状态同步：bookmark.list 不再含该文件夹（删除真实落库，非仅 UI 消失）
    await expect
      .poll(async () => {
        const stillThere = await window.evaluate(async () => {
          const u = window as unknown as {
            urchin: { invoke: (c: string, r?: unknown) => Promise<unknown> };
          };
          const res = (await u.urchin.invoke('bookmark.list', {})) as {
            bookmarks: { title: string }[];
          };
          return res.bookmarks.some((b) => b.title === 'E2E删除测试');
        });
        return stillThere;
      })
      .toBe(false);
  } finally {
    await electronApp.close();
  }
});

test('收藏夹面板：删除确认框取消后文件夹保留', async () => {
  const { electronApp } = await launchApp();

  try {
    const statusBar = await getStatusBarPage(electronApp);
    await statusBar.getByLabel('收藏夹').click();
    const panelWindow = await findPanelWindow(electronApp);
    panelWindow.on('dialog', (d) => {
      console.log('[folder-delete-debug] unexpected native dialog:', d.message());
      void d.dismiss().catch(() => {
        /* 面板可能已销毁 */
      });
    });

    // 新建文件夹
    await panelWindow.getByTitle('新建文件夹').click();
    const newFolderInput = panelWindow.locator('.new-folder-input');
    await expect(newFolderInput).toBeVisible();
    await newFolderInput.fill('E2E取消测试');
    await newFolderInput.press('Enter');
    const folderRow = panelWindow.locator('.folder-item', { hasText: 'E2E取消测试' });
    await expect(folderRow).toBeVisible({ timeout: 5_000 });

    // 点删除 → 确认框 → 取消 → 文件夹仍在，无 delete 调用效果
    await folderRow.getByTitle('删除').click();
    const confirmDialog = panelWindow.locator('.confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: '取消' }).click();
    await expect(folderRow).toBeVisible();
    await expect(confirmDialog).toHaveCount(0);

    // 主进程仍存在该文件夹
    const exists = await (
      await electronApp.firstWindow()
    ).evaluate(async () => {
      const u = window as unknown as {
        urchin: { invoke: (c: string, r?: unknown) => Promise<unknown> };
      };
      const res = (await u.urchin.invoke('bookmark.list', {})) as {
        bookmarks: { title: string }[];
      };
      return res.bookmarks.some((b) => b.title === 'E2E取消测试');
    });
    expect(exists).toBe(true);
  } finally {
    await electronApp.close();
  }
});
