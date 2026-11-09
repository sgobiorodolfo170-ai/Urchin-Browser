/**
 * 复现：关闭激活标签后，应激活侧边栏相邻的下一个标签（正下方），
 * 而不是跳到列表最底部（最旧）的标签（2026-11-10 用户指令）。
 *
 * 侧边栏按 id 倒序展示（新建置顶）：建 3 个新标签后自顶向底为
 * t4（激活）→ t3 → t2 → t1（首启标签，底）。关闭顶部的 t4，
 * 旧实现激活最底部的 t1（Set 插入序首个），新实现应激活正下方
 * 的 t3——以「唯一激活卡片位于列表顶部」断言。
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
import { setMainWindowSize } from './helpers/status-bar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function launchApp(): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-close-activation-'));

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
  await setMainWindowSize(electronApp);
  // 右侧栏默认折叠，双击右侧边栏空白处展开
  await window.locator('[aria-label="右侧边栏"]').first().dblclick();
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });

  return { electronApp, window };
}

/** 激活卡片样式标记（TabBar.tsx 激活态 border-primary/40，属性子串匹配避免类名转义）。 */
const ACTIVE_CARD_SELECTOR = '[data-tab-card][class*="border-primary/40"]';

test('关闭激活标签后激活相邻的下一个标签而非最底部标签', async () => {
  const { electronApp, window } = await launchApp();
  try {
    // 1. 连建 3 个新标签（每次都激活并置顶）：t4（顶）→ t3 → t2 → t1（底）
    for (let i = 2; i <= 4; i++) {
      await window.getByRole('button', { name: '新建标签' }).click();
      await expect(window.locator('[aria-label="关闭标签"]')).toHaveCount(i, { timeout: 10_000 });
    }

    // 2. 关闭顶部激活的 t4：悬浮卡片右上角 X（列表首个卡片的关闭钮）
    await window.locator('[data-tab-card]').first().locator('[aria-label="关闭标签"]').click();

    // 3. 断言：剩 3 个标签，且唯一激活卡片是列表首个（t3，正下方相邻）——
    //    旧行为会激活最底部的 t1，此时激活卡片是列表末个
    await expect(window.locator('[data-tab-card]')).toHaveCount(3, { timeout: 10_000 });
    await expect(window.locator(ACTIVE_CARD_SELECTOR)).toHaveCount(1);
    const cards = window.locator('[data-tab-card]');
    await expect(cards.first()).toHaveClass(/border-primary\/40/);
    await expect(cards.last()).not.toHaveClass(/border-primary\/40/);
  } finally {
    await electronApp.close();
  }
});
