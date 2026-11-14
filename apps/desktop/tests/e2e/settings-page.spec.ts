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

    // 选项卡切换：剪藏（含固定保存位置说明）/ 数据（含浏览器导入与 Cookie 开关）/ 隐私与安全
    await window.getByRole('button', { name: '剪藏', exact: true }).click();
    await expect(window.getByRole('heading', { name: '剪藏' })).toBeVisible();
    await expect(window.getByText('默认保存格式')).toBeVisible();

    await window.getByRole('button', { name: '数据', exact: true }).click();
    await expect(window.getByRole('heading', { name: '数据' })).toBeVisible();
    await expect(window.getByText('从其他浏览器导入')).toBeVisible();
    await expect(window.getByText('同时导入 Cookie（登录状态）')).toBeVisible();

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

    await window.getByRole('button', { name: '操作', exact: true }).click();
    const titlebarToggle = window
      .locator('div.flex.items-center.justify-between')
      .filter({ hasText: '标题栏展开/折叠按钮' })
      .getByRole('switch');
    await expect(titlebarToggle).toHaveAttribute('aria-checked', 'true');
    await window.evaluate(async () => {
      await globalThis.window.urchin.invoke('bookmark.create', {
        type: 'bookmark',
        title: '收藏栏测试',
        url: 'https://example.com',
      });
    });
    const sidebarsBefore = await window.locator('aside').evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      }),
    );
    await window.getByRole('button', { name: '展开收藏栏', exact: true }).click();
    const bar = window.getByRole('navigation', { name: '收藏栏', exact: true });
    await expect(bar.getByRole('button', { name: '收藏栏测试' })).toBeVisible();
    expect(
      await window.locator('aside').evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        }),
      ),
    ).toEqual(sidebarsBefore);
    const barBounds = (await bar.boundingBox())!;
    const sidebarBounds = await window.locator('aside').evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    expect(barBounds.x).toBeGreaterThanOrEqual(sidebarBounds[0]!.right - 1);
    expect(barBounds.x + barBounds.width).toBeLessThanOrEqual(sidebarBounds[1]!.left + 1);
    const itemBounds = (await bar.getByRole('button', { name: '收藏栏测试' }).boundingBox())!;
    expect(
      Math.abs(itemBounds.x + itemBounds.width / 2 - barBounds.x - barBounds.width / 2),
    ).toBeLessThan(2);
    const folderId = await window.evaluate(async () => {
      const api = globalThis.window.urchin;
      const folder = (await api.invoke('bookmark.create', {
        type: 'folder',
        title: '同步文件夹',
      })) as { bookmark: { id: string } };
      const child = (await api.invoke('bookmark.create', {
        type: 'bookmark',
        title: '同步子项',
        url: 'https://example.org',
        parentId: folder.bookmark.id,
      })) as { bookmark: { id: string } };
      await api.invoke('bookmark.update', { id: child.bookmark.id, title: '同步子项已重命名' });
      return folder.bookmark.id;
    });
    await expect(bar.getByRole('button', { name: '同步文件夹' })).toBeVisible();
    await expect(bar.getByRole('button', { name: '同步文件夹' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    );
    // 拦截原生菜单展示，验证实际构建的菜单与下拉锚点；原生菜单无需 DOM 浮层。
    await electronApp.evaluate(({ Menu }) => {
      Menu.prototype.popup = function (options) {
        const probe = globalThis as typeof globalThis & {
          bookmarkMenuProbe?: { labels: string[]; x?: number; y?: number };
        };
        probe.bookmarkMenuProbe = {
          labels: this.items.map((item) => item.label),
          x: options?.x,
          y: options?.y,
        };
        options?.callback?.();
      };
    });
    const folderBounds = (await bar.getByRole('button', { name: '同步文件夹' }).boundingBox())!;
    await bar.getByRole('button', { name: '同步文件夹' }).click();
    await expect
      .poll(async () =>
        electronApp.evaluate(
          () =>
            (globalThis as typeof globalThis & { bookmarkMenuProbe?: { labels: string[] } })
              .bookmarkMenuProbe?.labels,
        ),
      )
      .toEqual(['同步子项已重命名']);
    const menuPosition = await electronApp.evaluate(
      () =>
        (globalThis as typeof globalThis & { bookmarkMenuProbe?: { x: number; y: number } })
          .bookmarkMenuProbe!,
    );
    expect(menuPosition.x).toBe(Math.round(folderBounds.x));
    expect(menuPosition.y).toBe(Math.round(folderBounds.y + folderBounds.height));
    await window.evaluate(async (id) => {
      await globalThis.window.urchin.invoke('bookmark.delete', { id });
    }, folderId);
    await expect(bar.getByRole('button', { name: '同步文件夹' })).toHaveCount(0);
    await expect(window.getByRole('button', { name: '折叠收藏栏' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await titlebarToggle.click();
    await expect(bar).toHaveCount(0);
    await expect(window.getByRole('button', { name: '展开收藏栏' })).toHaveCount(0);
    await titlebarToggle.click();
    await expect(window.getByRole('button', { name: '展开收藏栏' })).toBeVisible();
    await window.getByRole('button', { name: '展开收藏栏' }).click();
    await bar.getByRole('button', { name: '收藏栏测试' }).click();
    await expect
      .poll(async () =>
        window.evaluate(async () => {
          const result = (await globalThis.window.urchin.invoke('tab.list', { windowId: 1 })) as {
            tabs: { active: boolean; url: string }[];
          };
          return result.tabs.find((tab) => tab.active)?.url;
        }),
      )
      .toMatch(/^https:\/\/example.com/);
    await electronApp.close();
  });
});
