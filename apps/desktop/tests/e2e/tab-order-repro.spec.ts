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
import { getOmniboxPage, setMainWindowSize } from './helpers/status-bar';

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
      URCHIN_TEST_DATA_DIR: join(userDataDir, 'data'),
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  // 与 CI runner 同尺寸（1024×720）：布局类回归只在窄窗口复现
  await setMainWindowSize(electronApp);
  // 右侧栏默认折叠，双击右侧边栏空白处展开（折叠/展开按钮已移除）
  await window.locator('[aria-label="右侧边栏"]').first().dblclick();
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });

  return { electronApp, window };
}

test('新建标签后旧标签保持原状态且置顶新标签', async () => {
  const { electronApp, window } = await launchApp();
  try {
    // 1. 地址栏导航 example.com（当前标签内导航；内部页地址栏在主窗口）
    const omniboxPage = await getOmniboxPage(electronApp, window);
    const omniboxInput = omniboxPage.getByRole('textbox', { name: '地址栏' });
    await omniboxInput.fill('https://example.com');
    await omniboxInput.press('Enter');
    await expect(window.getByText('Example Domain')).toBeVisible({ timeout: 15_000 });

    // 等待右侧栏标签显示页面标题
    await expect(window.getByText('Example Domain')).toBeVisible({ timeout: 15_000 });

    // 2. 新建标签
    await window.getByRole('button', { name: '新建标签' }).click();

    // 3. 等待标签数 = 2
    await expect(window.locator('[aria-label="关闭标签"]')).toHaveCount(2, { timeout: 10_000 });

    // 3.5 新标签标题应最终同步为"新标签页"（而非 URL）——home 占位不加载
    // BrowserView，标题由 tab-manager 的默认标题提供（dev.88 修复）
    // 注意：'新标签页' 文本在标签栏与右侧栏各出现一次，必须限定作用域，
    // 否则 getByText 会命中 2 个元素触发 Playwright strict mode 报错。
    await expect(
      window.locator('[aria-label="右侧边栏"]').getByText('新标签页').first(),
    ).toBeVisible({ timeout: 10_000 });

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
  } finally {
    // 断言失败也要收口：遗留实例会把同 worker 的后续用例拖成超时
    await electronApp.close();
  }
});

test('侧栏激活样式、拖动排序与固定留白在两种状态均可用', async () => {
  const { electronApp, window } = await launchApp();
  try {
    for (let i = 0; i < 15; i++)
      await window.getByRole('button', { name: '新建标签', exact: true }).click();
    const aside = window.locator('[aria-label="右侧边栏"]');
    for (const expanded of [true, false]) {
      const tabs = aside.locator('[data-tab-id]');
      await tabs.first().scrollIntoViewIfNeeded();
      const active = aside.locator('[data-tab-id][aria-current="page"]');
      await expect(active).toHaveCount(1);
      const activeId = await active.getAttribute('data-tab-id');
      expect(await active.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
      expect(
        await aside
          .locator('[data-tab-id]:not([aria-current])')
          .first()
          .evaluate((el) => getComputedStyle(el).boxShadow),
      ).toBe('none');
      const firstId = await tabs.first().getAttribute('data-tab-id');
      const first = await tabs.first().boundingBox();
      const second = await tabs.nth(1).boundingBox();
      if (!first || !second) throw new Error('missing tab bounds');
      await window.mouse.move(first.x + 15, first.y + 15);
      await window.mouse.down();
      await window.mouse.move(second.x + 15, second.y + second.height / 2, { steps: 8 });
      await window.mouse.up();
      await expect(tabs.nth(1)).toHaveAttribute('data-tab-id', firstId!);
      await expect(active).toHaveAttribute('data-tab-id', activeId!);
      const blank = aside.locator('[data-sidebar-blank]');
      expect((await blank.boundingBox())!.height).toBeGreaterThanOrEqual(48);
      const last = tabs.last();
      await last.scrollIntoViewIfNeeded();
      expect(
        (await last.boundingBox())!.y + (await last.boundingBox())!.height,
      ).toBeLessThanOrEqual((await blank.boundingBox())!.y);
      await blank.dblclick();
      await expect(aside.locator('[data-tab-card]')).toHaveCount(expanded ? 0 : 16);
    }
  } finally {
    await electronApp.close();
  }
});
