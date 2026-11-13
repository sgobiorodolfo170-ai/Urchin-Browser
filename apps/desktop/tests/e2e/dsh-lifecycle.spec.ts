/**
 * E2E：DSH 生命周期链路（§7.1 修复固化 · docs/DSH-遗留规划.md §一 R3）
 *
 * 真实 Electron + 真实 dsh web 子进程（不 mock 任何东西）。路径：
 * 1. 点侧栏 DeepSeek Harness 入口 → dsh.launch（真实 spawn vendor tsx 启动）
 * 2. 断言标签 URL 完成认证：首访带 token → 303 → 干净 URL（?token= 已消失）
 * 3. 其它标签聚焦时再次点入口 → 命中已有 dsh 标签（origin 匹配）→ 不重复开
 * 4. 再次点入口（dsh 标签已激活）→ 关闭标签 → tab-lifecycle 停后端 → state=stopped
 *
 * CI 友好守卫：开发态 dsh 需要 vendor/deepseek-harness 树 + 便携 node.exe，
 * 两者都不在版本控制内（P2-13 / ADR-016）。缺失时整组 skip——CI 未同步 vendor
 * 属正常态，不把这 4 个 spec 变红；本地全量复跑在两者齐备时真实执行。
 *
 * 前置：pnpm install + dist 已构建（pnpm build）+ vendor（pnpm sync:dsh）
 *      + 便携 Node（node scripts/fetch-node.mjs）。
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DESKTOP_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..');

/** 开发态 dsh 运行时前置：vendor 树 + 便携 node.exe（均不入版本控制） */
const DSH_DEV_RUNTIME_READY =
  existsSync(join(REPO_ROOT, 'vendor', 'deepseek-harness', 'package.json')) &&
  existsSync(join(DESKTOP_ROOT, 'build', 'node', 'node.exe'));

test.skip(
  !DSH_DEV_RUNTIME_READY,
  'dsh dev runtime unavailable：缺 vendor/deepseek-harness 或 build/node/node.exe（CI 正常态，本地跑 pnpm sync:dsh + fetch-node 后执行）',
);

/** 启动 Electron 应用并返回主窗口页面（与 pi-web-host.spec 同构） */
async function launchApp(): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-dsh-'));
  const electronApp = await electron.launch({
    cwd: DESKTOP_ROOT,
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
  window.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[renderer-console-error]', msg.text());
  });
  window.on('pageerror', (err) => {
    console.log('[renderer-pageerror]', err.message);
  });
  return { electronApp, window };
}

/** 渲染层 IPC 调用（window.urchin.invoke） */
async function invoke(window: Page, channel: string, req: unknown): Promise<unknown> {
  return window.evaluate(
    async ([ch, r]) => {
      const w = window as unknown as {
        urchin?: { invoke: (c: string, req: unknown) => Promise<unknown> };
      };
      if (!w.urchin) throw new Error('window.urchin 不可用');
      return w.urchin.invoke(ch, r);
    },
    [channel, req] as const,
  );
}

/** FastFetch 原型页探活：连接失败返回 0 */
async function probe(url: string): Promise<number> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.status;
  } catch {
    return 0;
  }
}

/** 从主进程 webContents 轮询拿全部 127.0.0.1:<port> 页面 URL */
async function pollServiceUrls(
  electronApp: ElectronApplication,
  port: number,
  deadlineMs: number,
): Promise<string[]> {
  return electronApp.evaluate(
    async ({ webContents }, { port, deadlineMs }) => {
      const deadline = Date.now() + deadlineMs;
      for (;;) {
        const urls = webContents
          .getAllWebContents()
          .map((w) => w.getURL())
          .filter((u) => u.startsWith(`http://127.0.0.1:${port}/`));
        if (urls.length > 0 || Date.now() >= deadline) return urls;
        await new Promise((r) => setTimeout(r, 500));
      }
    },
    { port, deadlineMs },
  );
}

/** 侧栏 DeepSeek Harness 入口点击（aria-label 稳定选择器） */
async function clickDshEntry(window: Page): Promise<void> {
  await window.getByLabel('DeepSeek Harness').click();
}

test.describe('DSH 生命周期（§7.1 修复固化）', () => {
  test('入口启动 → 303 干净 URL → 二次点击不重复开 → 关标签停后端', async () => {
    test.setTimeout(240_000);
    const { electronApp, window } = await launchApp();

    try {
      // 1. 首次点入口：dsh not running → launch → 打开认证 URL 标签
      await clickDshEntry(window);

      // 等待 launch 完成：dsh.status 变 running（冷启动含 tsx + Cordis，给足 120s+50%）
      await expect
        .poll(
          async () => {
            const s = (await invoke(window, 'dsh.status', {})) as { state: string; url?: string };
            return s.state;
          },
          { timeout: 150_000, intervals: [1_000] },
        )
        .toBe('running');

      const status = (await invoke(window, 'dsh.status', {})) as { state: string; url?: string };
      const dshUrl = status.url;
      expect(dshUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{43}$/);
      const port = Number(new URL(dshUrl!).port);
      const origin = new URL(dshUrl!).origin;

      // 2. 标签已打开（可能尚带 token），随后 303 重定向 → 干净 URL
      const urls = await pollServiceUrls(electronApp, port, 30_000);
      expect(urls.length).toBeGreaterThanOrEqual(1);
      // 等待认证完成：任一 dsh 标签的 URL 已不含 token（303 → './'）
      await expect
        .poll(
          async () => {
            const now = await pollServiceUrls(electronApp, port, 1_000);
            return now.some((u) => new URL(u).origin === origin && !u.includes('token='));
          },
          { timeout: 30_000, intervals: [1_000] },
        )
        .toBe(true);

      // 后端就绪与认证成功不代表前端已挂载：必须看到真实侧栏控件，防止空白页假绿。
      await expect
        .poll(
          async () =>
            electronApp.evaluate(async ({ webContents }, origin) => {
              const view = webContents
                .getAllWebContents()
                .find((w) => w.getURL().startsWith(origin + '/'));
              if (!view) return false;
              return (await view.executeJavaScript(
                `Boolean(document.querySelector('[data-sidebar-toggle], [data-sidebar-opener]'))`,
              )) as boolean;
            }, origin),
          { timeout: 30_000, intervals: [500], message: 'DSH 前端侧栏组件应实际挂载' },
        )
        .toBe(true);
      const rendered = await electronApp.evaluate(async ({ webContents }, origin) => {
        const view = webContents
          .getAllWebContents()
          .find((w) => w.getURL().startsWith(origin + '/'))!;
        return (await view.capturePage()).toPNG().toString('base64');
      }, origin);
      writeFileSync(test.info().outputPath('dsh-rendered.png'), Buffer.from(rendered, 'base64'));
      await test.info().attach('dsh-rendered', {
        body: Buffer.from(rendered, 'base64'),
        contentType: 'image/png',
      });

      // 3. 开一个无关标签使其聚焦（非 dsh 标签激活态），再点入口：
      //    origin 匹配应命中已存在的 dsh 标签 → 激活而非新开（重复开标签缺陷回归位）
      await invoke(window, 'tab.create', { windowId: 1, url: 'urchin://newtab', active: true });

      // 等待标签清单稳定（主进程创建已完成）——tab.list 响应形状为 { tabs: [...]
      // （ipc-schema.ts tabListResSchema），不是裸数组}
      const tabsBefore = (
        (await invoke(window, 'tab.list', {})) as {
          tabs: { id: number; url: string; active: boolean }[];
        }
      ).tabs;
      const dshTabsBefore = tabsBefore.filter((t) => {
        try {
          return new URL(t.url).origin === origin;
        } catch {
          return false;
        }
      });
      expect(dshTabsBefore.length).toBe(1);
      const dshTabId = dshTabsBefore[0]!.id;

      await clickDshEntry(window);

      const tabsAfter = (
        (await invoke(window, 'tab.list', {})) as {
          tabs: { id: number; url: string; active: boolean }[];
        }
      ).tabs;
      const dshTabsAfter = tabsAfter.filter((t) => {
        try {
          return new URL(t.url).origin === origin;
        } catch {
          return false;
        }
      });
      // 不重复开：仍只有同一个 dsh 标签，且已被激活
      expect(dshTabsAfter.length).toBe(1);
      expect(dshTabsAfter[0]!.id).toBe(dshTabId);
      expect(dshTabsAfter[0]!.active).toBe(true);

      // 4. dsh 标签已激活 → 再点入口 = 关闭标签 → tab-lifecycle 停后端
      await clickDshEntry(window);

      // 后端停止：state → stopped（stop 含 taskkill 进程树，15s 足够）
      await expect
        .poll(
          async () => {
            const s = (await invoke(window, 'dsh.status', {})) as { state: string };
            return s.state;
          },
          { timeout: 20_000, intervals: [500] },
        )
        .toBe('stopped');

      // 服务端口应不可达（进程树已退出）
      expect(await probe(dshUrl!)).toBe(0);
    } finally {
      // 兜底：防止状态机残留 running 的子进程拖过用例边界
      const s = (await invoke(window, 'dsh.status', {})) as { state: string };
      if (s.state === 'running') {
        await invoke(window, 'dsh.stop', {}).catch(() => undefined);
      }
      await electronApp.close();
    }
  });
});
