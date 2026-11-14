import { test, electron } from './helpers/electron-test';
/**
 * 设置页 E2E 冒烟（refactor-plan-p2 §Session3 必跑清单所列
 * settings-page-component 的落地；此前该页无任何 E2E 覆盖）
 *
 * 覆盖：左侧栏入口 → 页面渲染 → 选项卡切换 → 字段变更自动保存（toast）。
 * 数据目录与 userData 均隔离到临时目录（设置值存共享设置库，不隔离会
 * 污染用户真实设置/用例互污，见 workspaces.spec 同款注释）。
 */
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

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
      .filter({ hasText: '显示书签栏' })
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
    const appearance = await bar.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        radius: parseFloat(style.borderTopLeftRadius),
        height: el.clientHeight,
        background: style.backgroundImage,
        scrollbar: style.scrollbarWidth,
      };
    });
    expect(appearance.radius).toBeGreaterThanOrEqual(appearance.height / 2);
    expect(appearance.background).toContain('linear-gradient');
    expect(appearance.scrollbar).toBe('none');
    const wideItemId = await window.evaluate(async () => {
      const result = (await globalThis.window.urchin.invoke('bookmark.create', {
        type: 'bookmark',
        title: '内容自动调节宽度'.repeat(5),
        url: 'https://example.net',
      })) as { bookmark: { id: string } };
      return result.bookmark.id;
    });
    await expect
      .poll(async () => (await bar.boundingBox())!.width)
      .toBeGreaterThan(barBounds.width + 20);
    const expandedWidth = (await bar.boundingBox())!.width;
    expect(expandedWidth).toBeLessThanOrEqual(sidebarBounds[1]!.left - sidebarBounds[0]!.right);
    await window.evaluate(async (id) => {
      await globalThis.window.urchin.invoke('bookmark.delete', { id });
    }, wideItemId);
    await expect.poll(async () => (await bar.boundingBox())!.width).toBe(barBounds.width);

    const overflowIds = await window.evaluate(async () => {
      const ids: string[] = [];
      for (let i = 0; i < 16; i++) {
        const result = (await globalThis.window.urchin.invoke('bookmark.create', {
          type: 'folder',
          title: `滚动测试文件夹-${i}-收藏内容`,
        })) as { bookmark: { id: string } };
        ids.push(result.bookmark.id);
      }
      return ids;
    });
    await expect
      .poll(async () => bar.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeGreaterThan(300);
    const scrollBox = (await bar.boundingBox())!;
    await window.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
    await window.mouse.wheel(0, 280);
    await expect.poll(async () => bar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    await window.mouse.wheel(0, -10000);
    await expect.poll(async () => bar.evaluate((el) => el.scrollLeft)).toBe(0);
    await window.mouse.wheel(140, 0);
    await expect.poll(async () => bar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50);
    const screenshotPath = test.info().outputPath('bookmarks-capsule-overflow.png');
    await window.screenshot({ path: screenshotPath });
    await test
      .info()
      .attach('书签栏胶囊与溢出滚动', { path: screenshotPath, contentType: 'image/png' });
    await window.evaluate(async (ids) => {
      for (const id of ids) await globalThis.window.urchin.invoke('bookmark.delete', { id });
    }, overflowIds);
    await expect.poll(async () => (await bar.boundingBox())!.width).toBe(barBounds.width);

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
    // 与真实地址栏卡片对比：内容少或为空时，最小宽度恰好为地址栏的一半。
    const addressBar = electronApp
      .windows()
      .find((page) => new URL(page.url()).searchParams.get('view') === 'statusbar');
    expect(addressBar).toBeDefined();
    const card = addressBar!.locator('.status-bar-card');
    await expect(card).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await bar.boundingBox())!.width - (await card.boundingBox())!.width / 2),
      )
      .toBeLessThan(1);
    await window.getByRole('button', { name: '展开左侧栏', exact: true }).click();
    await expect
      .poll(async () =>
        Math.abs((await bar.boundingBox())!.width - (await card.boundingBox())!.width / 2),
      )
      .toBeLessThan(1);
    await window.evaluate(async () => {
      const api = globalThis.window.urchin;
      const result = (await api.invoke('bookmark.list', {})) as { bookmarks: { id: string }[] };
      for (const item of result.bookmarks) await api.invoke('bookmark.delete', { id: item.id });
    });
    await expect(bar.getByText('暂无收藏', { exact: true })).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await bar.boundingBox())!.width - (await card.boundingBox())!.width / 2),
      )
      .toBeLessThan(1);
    const region = bar.locator('..');
    await expect(region).toHaveCSS('background-image', 'none');
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body>background sync test</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing');
    const backgroundUrl = `http://127.0.0.1:${address.port}/`;
    try {
      await window.evaluate(async (url) => {
        const api = globalThis.window.urchin;
        const result = (await api.invoke('tab.list', { windowId: 1 })) as {
          tabs: { id: number; active: boolean }[];
        };
        await api.invoke('tab.loadUrl', { tabId: result.tabs.find((tab) => tab.active)!.id, url });
      }, backgroundUrl);
      await expect
        .poll(async () =>
          electronApp.evaluate(
            ({ webContents }, url) =>
              webContents.getAllWebContents().some((view) => view.getURL() === url),
            backgroundUrl,
          ),
        )
        .toBe(true);
      const recolorPage = async (color: string) => {
        await electronApp.evaluate(
          async ({ webContents }, background) => {
            const page = webContents
              .getAllWebContents()
              .find((view) => view.getURL() === background.url);
            if (!page) throw new Error('external page missing');
            await page.executeJavaScript(
              `document.documentElement.style.backgroundColor = ${JSON.stringify(background.color)}; document.body.style.backgroundColor = ${JSON.stringify(background.color)};`,
            );
          },
          { color, url: backgroundUrl },
        );
      };
      await recolorPage('rgb(18, 52, 86)');
      await expect(region).toHaveCSS('background-color', 'rgb(18, 52, 86)', { timeout: 10000 });
      await recolorPage('rgb(24, 25, 28)');
      await expect(region).toHaveCSS('background-color', 'rgb(24, 25, 28)', { timeout: 10000 });
      await window.getByRole('button', { name: '设置', exact: true }).click();
      await expect
        .poll(async () =>
          region.evaluate(
            (el) =>
              getComputedStyle(el).backgroundColor ===
              getComputedStyle(document.querySelector('main .bg-surface')!).backgroundColor,
          ),
        )
        .toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await electronApp.close();
  });
});
