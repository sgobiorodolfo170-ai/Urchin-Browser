/**
 * E2E 测试：重启后恢复工作区与已打开标签（TP4 + TP7 持久化闭环）
 *
 * 回归背景（2026-11-09）：SettingsManager 构造时只加载 DEFAULT_SETTINGS 中登记的键，
 * `session.lastTabs` / `workspaces.registry` 漏登记 → 退出时落盘正常、重启却读不回，
 * 表现为「自定义工作区丢失 + 上次打开的网页标签不再恢复」。
 *
 * 覆盖链路（同一 userData 两次启动）：
 * 1. 首次启动：创建工作区 + 在默认工作区/新工作区各开一个网页标签；
 * 2. 优雅退出（before-quit → performCleanup 写 session.lastTabs）；
 * 3. 同一 userData 重启：工作区元数据仍在、默认工作区标签恢复；
 * 4. 切到自定义工作区：上次打开的标签按 TP4 懒恢复。
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 本地页面：标题固定，便于断言标签恢复后的 title。 */
function startPageServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
        '<title>restore-page</title></head><body><h1>restore</h1></body></html>',
    );
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

/** 启动 Electron（指定 userData/data 目录，便于重启复用同一份数据库）。 */
async function launchApp(userDataDir: string): Promise<{
  electronApp: ElectronApplication;
  window: Page;
}> {
  const electronApp = await electron.launch({
    cwd: resolve(__dirname, '..', '..'),
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

interface TabView {
  url: string;
  title: string;
  workspaceId: string;
  active: boolean;
  windowId: number;
}

/** 读当前全部标签（渲染层经既有 urchin.invoke 通道，不 mock 主进程）。 */
async function listTabs(window: Page): Promise<TabView[]> {
  return window.evaluate(async () => {
    const urchin = (
      window as unknown as {
        urchin: { invoke: (c: string, r: unknown) => Promise<unknown> };
      }
    ).urchin;
    const res = (await urchin.invoke('tab.list', {})) as { tabs: TabView[] };
    return res.tabs;
  });
}

test.describe('重启恢复（TP4 / TP7）', () => {
  test('should restore workspaces and open tabs after restart', async () => {
    test.setTimeout(120_000);
    const { server, base } = await startPageServer();
    const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-session-restore-'));
    const defaultUrl = `${base}/restore`;
    const workspaceUrl = `${base}/restore?ws=1`;

    let electronApp: ElectronApplication | undefined;
    try {
      // ── 1. 首次启动：建工作区、开两个网页标签 ──
      const first = await launchApp(userDataDir);
      electronApp = first.electronApp;
      const window = first.window;

      const created = await window.evaluate(
        async (urls: { defaultUrl: string; workspaceUrl: string }) => {
          const urchin = (
            window as unknown as {
              urchin: { invoke: (c: string, r: unknown) => Promise<unknown> };
            }
          ).urchin;
          const list = (await urchin.invoke('tab.list', {})) as { tabs: TabView[] };
          const windowId = list.tabs[0]?.windowId;
          if (windowId == null) throw new Error('no window');
          const wsRes = (await urchin.invoke('workspace.create', {
            name: '重启工作区',
            color: 'violet',
          })) as { workspace: { id: string } };
          // 默认工作区：后台网页标签（主进程启动时直接恢复）
          await urchin.invoke('tab.create', {
            windowId,
            url: urls.defaultUrl,
            active: false,
            workspaceId: 'default',
          });
          // 新工作区：再开一个并激活（重启后切到该工作区时懒恢复）
          await urchin.invoke('tab.create', {
            windowId,
            url: urls.workspaceUrl,
            active: true,
            workspaceId: wsRes.workspace.id,
          });
          return { windowId, workspaceId: wsRes.workspace.id };
        },
        { defaultUrl, workspaceUrl },
      );

      // 等两个页面都加载出标题（确保落盘的是可用快照，而非空标题）
      await expect
        .poll(
          async () => (await listTabs(window)).filter((t) => t.title === 'restore-page').length,
          {
            timeout: 20_000,
          },
        )
        .toBe(2);

      // ── 2. 优雅退出：触发 before-quit → performCleanup 写 session.lastTabs ──
      const closed = electronApp.waitForEvent('close');
      await electronApp.evaluate(({ app }) => app.quit()).catch(() => undefined);
      await closed;
      electronApp = undefined;

      // ── 3. 同一 userData 重启：工作区与默认工作区标签恢复 ──
      const second = await launchApp(userDataDir);
      electronApp = second.electronApp;
      const restarted = second.window;

      const state = await restarted.evaluate(async () => {
        const urchin = (
          window as unknown as {
            urchin: { invoke: (c: string, r: unknown) => Promise<unknown> };
          }
        ).urchin;
        const ws = (await urchin.invoke('workspace.list', {})) as {
          workspaces: { id: string; name: string }[];
        };
        const tabs = (await urchin.invoke('tab.list', {})) as { tabs: TabView[] };
        return { workspaces: ws.workspaces, tabs: tabs.tabs };
      });

      expect(state.workspaces.map((w) => w.name)).toContain('重启工作区');
      expect(
        state.tabs.some((t) => t.workspaceId === 'default' && t.url.startsWith(defaultUrl)),
      ).toBe(true);

      // ── 4. 切到自定义工作区：TP4 懒恢复上次打开的标签 ──
      await restarted.mouse.move(10, 10);
      await restarted
        .locator('[aria-label="右侧边栏"]')
        .first()
        .evaluate((el) => {
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        });
      await restarted
        .getByRole('button', { name: '新建标签' })
        .waitFor({ state: 'visible', timeout: 15_000 });
      await restarted
        .getByRole('button', { name: /重启工作区/ })
        .first()
        .click();

      await expect
        .poll(
          async () =>
            (await listTabs(restarted)).some(
              (t) => t.workspaceId === created.workspaceId && t.url.startsWith(workspaceUrl),
            ),
          { timeout: 20_000 },
        )
        .toBe(true);
    } finally {
      await electronApp?.close();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });
});
