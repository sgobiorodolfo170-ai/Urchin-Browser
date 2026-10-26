/**
 * E2E 测试：工作区（TP7）Cookie 隔离 + 切换恢复 + 卡片总览页
 *
 * 覆盖路径：
 * 1. 本地 HTTP 服务提供 /login?name=<会话名> 与 /whoami：
 *    - /login 设置 Cookie account=<会话名>，返回标题/正文携带该会话名
 *    - /whoami 读取 Cookie 显示当前会话（无 Cookie = 未登录）
 * 2. 启动应用 → 展开右侧栏 → 通过「+」创建工作区「工作A」
 *    → 自动切换到新工作区并新建主页标签
 * 3. 在工作区A 登录 alice → 切回默认工作区登录 bob（两会话互不可见）
 * 4. 切回工作区A 应恢复 alice 会话（最近激活标签）
 * 5. 折叠右侧栏 → 悬停顶部工作区图标滚动滚轮 → 切到默认工作区恢复 bob 会话
 * 6. cards 模式（点击卡片）：折叠态点工作区图标 → 打开 urchin://workspaces 总览页，
 *    卡片网格展示全部工作区 + 新建卡；点工作区卡 → 关闭总览页并切换到对应工作区
 *
 * 引擎注入：无（纯本地 HTTP fixture，不 mock 页面）。
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getOmniboxPage, getStatusBarPage } from './helpers/status-bar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 构造会话页：<title> 与正文都携带会话名，便于侧栏标签标题断言。 */
function sessionPageHtml(session: string, path: string): string {
  const name = session || '未登录';
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>sess:${name}</title></head>
<body><h1>session=${name}</h1><p>path=${path}</p></body>
</html>`;
}

/**
 * 本地假服务：
 * - GET /login?name=<会话名> → Set-Cookie account=<会话名>，正文显示该会话
 * - GET /whoami           → 读 Cookie，显示当前会话（无 Cookie = 未登录）
 */
function startWorkspaceServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/login') {
      const name = url.searchParams.get('name') ?? '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Set-Cookie', `account=${encodeURIComponent(name)}; Path=/`);
      res.end(sessionPageHtml(name, '/login'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/whoami') {
      const cookie = req.headers.cookie ?? '';
      const match = /(?:^|;\s*)account=([^;]+)/.exec(cookie);
      const name = match ? decodeURIComponent(match[1] ?? '') : '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(sessionPageHtml(name, '/whoami'));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

/** 启动 Electron 应用（独立 userData，隔离既有会话）。 */
async function launchApp(): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-workspaces-'));
  const electronApp = await electron.launch({
    cwd: appPath,
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYWRIGHT: '1',
      URCHIN_TEST_USER_DATA: userDataDir,
      // 数据目录也隔离到临时目录：工作区切换模式（ui.workspaceSwitcherMode）存在
      // 设置库中，共享 apps/desktop/data 会让用例互相污染（如 cards 模式残留）。
      URCHIN_TEST_DATA_DIR: join(userDataDir, 'data'),
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window };
}

/** 派发 aside 的 dblclick（确定性切换折叠/展开）。
 *  不用真实 mouse.dblclick：鼠标移入会触发悬停自动展开，导致定位/展开状态漂移。 */
async function toggleRightSidebar(window: Page): Promise<void> {
  await window.mouse.move(10, 10);
  await window
    .locator('[aria-label="右侧边栏"]')
    .first()
    .evaluate((el) => {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
  await window.waitForTimeout(50);
}

/** 展开右侧边栏（确定性，非悬停预览）；移开鼠标后仍保持展开。 */
async function expandRightSidebar(window: Page): Promise<void> {
  await toggleRightSidebar(window);
  await window.mouse.move(10, 10);
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });
}

/** 在地址栏导航并等待输入框 URL 变化（内部页地址栏在主窗口；外部页在悬浮状态栏）。 */
async function navigateAndWait(
  electronApp: ElectronApplication,
  window: Page,
  base: string,
  path: string,
): Promise<void> {
  const omniboxPage = await getOmniboxPage(electronApp, window);
  const omniboxInput = omniboxPage.getByRole('textbox', { name: '地址栏' });
  await omniboxInput.fill(`${base}${path}`);
  await omniboxInput.press('Enter');
  // 导航完成后地址栏在悬浮状态栏（外部页）
  const statusBar = await getStatusBarPage(electronApp);
  await expect(statusBar.getByRole('textbox', { name: '地址栏' })).toHaveValue(
    new RegExp(`${base.replace('.', '\\.')}${path.replace('?', '\\?').replace('=', '\\=')}`),
    {
      timeout: 15_000,
    },
  );
}

test.describe('工作区（TP7）', () => {
  test('should isolate cookies between workspaces and restore last active tab on switch', async () => {
    const { server, port } = await startWorkspaceServer();
    const base = `http://127.0.0.1:${port}`;
    const { electronApp, window } = await launchApp();

    try {
      await expandRightSidebar(window);

      // ── 创建工作区「工作A」（创建后自动切换到它并新建主页标签） ──
      await window.getByRole('button', { name: '新建工作区' }).click();
      const nameInput = window.getByPlaceholder('工作区名称');
      await nameInput.fill('工作A');
      await nameInput.press('Enter');
      // 创建工作区弹出面板收起 → 选项卡条出现「工作A」
      await expect(window.getByRole('button', { name: /工作A/ }).first()).toBeVisible({
        timeout: 15_000,
      });

      // ── 在工作区A 登录 alice ──
      await navigateAndWait(electronApp, window, base, '/login?name=alice');
      await expect(window.getByText('sess:alice').first()).toBeVisible({ timeout: 20_000 });
      // 验证 /whoami 在同一会话看到 alice（Cookie 已写入分区）
      await navigateAndWait(electronApp, window, base, '/whoami');
      await expect(window.getByText('sess:alice').first()).toBeVisible({ timeout: 20_000 });

      // ── 切回默认工作区：默认分区无 alice Cookie → 登录 bob ──
      await window
        .getByRole('button', { name: /默认工作区/ })
        .first()
        .click();
      await navigateAndWait(electronApp, window, base, '/login?name=bob');
      await expect(window.getByText('sess:bob').first()).toBeVisible({ timeout: 20_000 });

      // ── 切回工作区A：恢复 alice 会话（最近激活标签），bob 不可见 ──
      await window.getByRole('button', { name: /工作A/ }).first().click();
      await expect(window.getByText('sess:alice').first()).toBeVisible({ timeout: 20_000 });
      await expect(window.getByText('sess:bob').first()).not.toBeVisible();

      // ── 折叠右侧栏：顶部工作区图标滚轮 → 切回默认工作区（bob） ──
      // 显式切回 wheel 模式（开发模式数据目录共享 apps/desktop/data/urchin.db，
      // 上一个 cards 用例可能已持久化 cards，这里恢复默认以测试滚轮循环链路）
      await window.evaluate(async () => {
        const urchin = (
          window as unknown as {
            urchin: { invoke: (c: string, r: unknown) => Promise<unknown> };
          }
        ).urchin;
        await urchin.invoke('settings.set', { key: 'ui.workspaceSwitcherMode', value: 'wheel' });
        (window as unknown as Window).dispatchEvent(
          new CustomEvent('urchin:settings-changed', {
            detail: { keys: ['ui.workspaceSwitcherMode'] },
          }),
        );
      });
      await window
        .locator('[aria-label="右侧边栏"]')
        .first()
        .evaluate((el) => {
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        });
      // 移开鼠标，避免悬停自动展开把折叠态的 switcher 顶掉（滚动切换目标随之消失）
      await window.mouse.move(10, 10);
      const switcher = window.locator('[aria-label^="切换工作区"]').first();
      await expect(switcher).toBeVisible({ timeout: 15_000 });
      // 向按钮派发 wheel（bubbles）触发折叠态滚轮切换。
      // 说明：不用 Playwright mouse.wheel——在 Electron/Windows 下经合成鼠标
      // 路由到按钮的 wheel 偶发不达；直接 dispatch 到元素可确定性验证
      // onWheel→切换链路（鼠标已移开，折叠态保持稳定）。
      //
      // ⚠ 方向必须是「向上」（deltaY < 0）：切换器按 `idx + dir` 非循环移动
      // （到首/尾即停，见 App.handleCycleWorkspace）。当前在工作区A（列表末尾），
      // 向下滚会越界返回、不发生切换；向上滚才回到默认工作区。
      await switcher.evaluate((el) => {
        el.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }),
        );
      });
      // 先等待 switcher 反映当前工作区已切回默认（React 状态同步，比标签 title 快）
      await expect(switcher).toHaveAttribute('aria-label', /默认工作区/, { timeout: 15_000 });
      // 折叠态标签图标 title 反映标签标题
      await expect(window.locator('[title="sess:bob"]').first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await electronApp.close();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  test('should open workspaces overview page and switch via cards in cards mode', async () => {
    const { server } = await startWorkspaceServer();
    const { electronApp, window } = await launchApp();

    try {
      // ── 创建两个工作区（默认 + 工作A），各获得一个主页标签 ──
      await expandRightSidebar(window);
      await window.getByRole('button', { name: '新建工作区' }).click();
      const nameInput = window.getByPlaceholder('工作区名称');
      await nameInput.fill('工作A');
      await nameInput.press('Enter');
      await expect(window.getByRole('button', { name: /工作A/ }).first()).toBeVisible({
        timeout: 15_000,
      });

      // ── 折叠右侧栏，切换到「点击卡片」模式（参考 ego-lite Space 卡片设计）──
      await toggleRightSidebar(window);
      await window.evaluate(async () => {
        const urchin = (
          window as unknown as {
            urchin: { invoke: (c: string, r: unknown) => Promise<unknown> };
          }
        ).urchin;
        await urchin.invoke('settings.set', { key: 'ui.workspaceSwitcherMode', value: 'cards' });
        (window as unknown as Window).dispatchEvent(
          new CustomEvent('urchin:settings-changed', {
            detail: { keys: ['ui.workspaceSwitcherMode'] },
          }),
        );
      });

      // ── 点击顶部工作区图标 → 打开工作区总览页（urchin://workspaces）──
      const switcher = window.getByRole('button', { name: /^切换工作区/ }).first();
      await switcher.click();
      // 总览页成为激活标签（仅卡片网格，无标题/说明文案）
      const overviewPage = window.locator('[aria-label="工作区总览"]');
      await expect(overviewPage).toBeVisible({
        timeout: 15_000,
      });
      // 卡片列出全部工作区 + 新建卡（卡片按钮 title=切换到工作区 <名称>）
      const overview = window.locator('button[title^="切换到工作区"]');
      await expect(overview.filter({ hasText: '工作A' })).toBeVisible();
      await expect(overview.filter({ hasText: '默认' })).toBeVisible();
      const newCard = window.getByRole('button', { name: '新建工作区' });
      await expect(newCard).toBeVisible();
      // 新建卡只保留「+」图标，不再显示可见文字（aria-label 仍保留可访问名称）
      await expect(newCard).not.toHaveText('新建工作区');
      // 新建卡内底色必须比窗口底色更暗（亮色 rgba(0,0,0,.14) / 暗色更深）
      expect(await newCard.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
        'rgba(0, 0, 0, 0)',
      );

      // ── 窗口级背景：标题栏同色为顶部基调，向下渐变 + 极淡品牌色径向光晕 ──
      const windowBg = window.locator('[data-app-window-bg="true"]');
      const bgImage = await windowBg.evaluate((el) => getComputedStyle(el).backgroundImage);
      expect(bgImage).toContain('linear-gradient');
      expect(bgImage).toContain('radial-gradient');
      // 总览页自身透明，直接透出窗口级渐变（不再有独立背景造成色带）
      const overviewBg = await overviewPage.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(overviewBg).toBe('rgba(0, 0, 0, 0)');

      // ── 3D 悬浮：内层视觉层随指针倾斜，移开后复位（命中区不抖动） ──
      const workACard = overview.filter({ hasText: '工作A' });
      const cardVisual = workACard.locator('[data-workspace-card-visual="true"]');
      const restingTransform = await cardVisual.evaluate((el) => getComputedStyle(el).transform);
      const cardBox = await workACard.boundingBox();
      expect(cardBox).not.toBeNull();
      if (cardBox) {
        await window.mouse.move(
          cardBox.x + cardBox.width * 0.78,
          cardBox.y + cardBox.height * 0.28,
        );
      }
      await expect
        .poll(() => cardVisual.evaluate((el) => getComputedStyle(el).transform), { timeout: 3_000 })
        .not.toBe(restingTransform);
      await window.mouse.move(10, 10);
      await expect
        .poll(() => cardVisual.evaluate((el) => getComputedStyle(el).transform), { timeout: 3_000 })
        .toBe(restingTransform);

      // ── 点击「工作A」卡片 → 总览页关闭，切到工作A（图标反映） ──
      await workACard.click();
      await expect(overviewPage).toBeHidden();
      await expect(window.getByRole('button', { name: /^切换工作区/ }).first()).toHaveAttribute(
        'title',
        /工作A/,
      );

      // ── 再次打开总览页 → 点击「默认」卡片 → 切回默认工作区 ──
      await window
        .getByRole('button', { name: /^切换工作区/ })
        .first()
        .click();
      await expect(overviewPage).toBeVisible({
        timeout: 15_000,
      });
      await overview.filter({ hasText: '默认' }).click();
      await expect(overviewPage).toBeHidden();
      await expect(window.getByRole('button', { name: /^切换工作区/ }).first()).toHaveAttribute(
        'title',
        /默认工作区/,
      );
    } finally {
      await electronApp.close();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });
});
