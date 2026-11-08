/**
 * E2E：pi 阶段 2 自研托管服务链路（docs/pi-web-评估.md 阶段 2 / M2A 骨架）
 *
 * 验证「自研前端 + utilityProcess 托管服务」整链路：
 * 1. 真实 Electron 启动（不 mock）→ 渲染层 preload→IPC 调用 pihost.launch
 * 2. 主进程 utilityProcess.fork @urchin/pi-web-host → 捕获 stdout 就绪 URL（带 token）
 * 3. 鉴权正确性：带 token → HTTP 200（自研前端页面）；无 token → 401
 * 4. 标签页打开自研前端：WS（hello_ok）握手达成，页面显示「已握手」
 * 5. 关闭应用 → performCleanup 终止 utility 子进程 → 端口不可达（与主项目同生共死）
 *
 * 前置：pnpm install + dist 已构建（pnpm build 生成 dist/main/pi-web-host.js 与 dist/pi-web）
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

/** 启动 Electron 应用并返回主窗口页面（与 pi-web-launcher.spec 同构） */
async function launchApp(): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-piwebhost-'));
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

/** HTTP 探活：返回状态码（连接失败返回 0） */
async function probe(url: string): Promise<number> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * 等待 pi 页面完成 WS 握手。
 *
 * pi 前端只有在收到 `hello_ok` 后才会把 chat.ready 置 true，并渲染
 * `.bar-item-conn.ok` 状态灯；用该 DOM 状态验证握手，比测试进程直接连 WS 更贴近
 * 真实用户路径（Node/undici 的 WebSocket 对该 upgrade 会直接报 error）。
 */
async function waitForConnected(
  electronApp: ElectronApplication,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await electronApp.evaluate(async ({ webContents }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => /^http:\/\/127\.0\.0\.1:\d+/.test(w.getURL()));
      if (!wc) return false;
      try {
        return (await wc.executeJavaScript(
          '!!document.querySelector(".bar-item-conn.ok")',
        )) as boolean;
      } catch {
        return false;
      }
    });
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

test.describe('pi 阶段 2 自研托管服务（M2A 骨架）', () => {
  test('launch → 鉴权 URL → 前端加载 + WS 握手 → 退出杀进程', async () => {
    test.setTimeout(150_000);
    const { electronApp, window } = await launchApp();

    // 1. 启动托管服务（渲染层 → 主进程 IPC → utilityProcess.fork）
    const launchRes = (await invoke(window, 'pihost.launch', {})) as {
      ok: boolean;
      url: string;
      port: number;
    };
    expect(launchRes.ok).toBe(true);
    expect(launchRes.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{43}$/);
    expect(launchRes.port).toBeGreaterThan(0);
    const url = launchRes.url;

    try {
      // 2. 状态快照 running
      const status = (await invoke(window, 'pihost.status', {})) as {
        state: string;
        url?: string;
      };
      expect(status.state).toBe('running');
      expect(status.url).toBe(url);

      // 3. 鉴权：带 token 200，无 token 401
      expect(await probe(url)).toBe(200);
      expect(await probe(`http://127.0.0.1:${launchRes.port}/`)).toBe(401);

      // 4. 带 token 页面 HTML 包含 pi 标题
      const body = await (await fetch(url)).text();
      expect(body).toContain('pi');

      // 5. 在标签页打开自研前端 → React 渲染 + WebSocket 连接
      await invoke(window, 'tab.create', {
        windowId: 1,
        url,
        active: true,
      });

      // 用 webContents 定位 BrowserView 页面——验证标签页已打开且 URL 正确。
      // React 渲染深度验证留给实机验收（module script 加载时序 + crossorigin 在
      // BrowserView 中可能不稳定，不影响核心链路验证）。
      const result = await electronApp.evaluate(
        async ({ webContents }, { basePort }): Promise<{ found: boolean; url: string }> => {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const wc = webContents
              .getAllWebContents()
              .find((w) => w.getURL().startsWith(`http://127.0.0.1:${basePort}`));
            if (wc) {
              return { found: true, url: wc.getURL() };
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          return { found: false, url: '' };
        },
        { basePort: launchRes.port },
      );
      expect(result.found).toBe(true);
      // BrowserView 加载后 URL 中的 token 被 Cookie 取代（server.ts Set-Cookie 后不再需要 query token），
      // 只验证页面已打开到正确端口即可；token 已在 launchRes.url（第 91 行）中验证。
      expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

      // 6. P7：等待页面进入「已连接」（hello_ok 后 chat.ready=true → .bar-item-conn.ok）
      expect(await waitForConnected(electronApp)).toBe(true);
    } finally {
      // 6. 关闭应用 → utility 子进程随 performCleanup 终止 → 端口不可达
      await electronApp.close();
    }

    expect(await probe(url).catch(() => 0)).toBe(0);
    expect(await probe(`http://127.0.0.1:${launchRes.port}/`).catch(() => 0)).toBe(0);
  });

  test('π 按钮 → 服务启动 → pi 页面渲染 → 无凭据仍可 WS 握手', async () => {
    test.setTimeout(180_000);
    const { electronApp, window } = await launchApp();

    try {
      // 1. 点击左侧栏 π 入口（真实用户路径：确保服务运行 + 打开/聚焦聊天页）
      const piButton = window.locator('button[aria-label="pi"]').first();
      await expect(piButton).toBeVisible({ timeout: 15_000 });
      await piButton.click();

      // 2. 等待 BrowserView 打开 127.0.0.1 的 pi 页面
      const opened = await electronApp.evaluate(async ({ webContents }) => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const wc = webContents
            .getAllWebContents()
            .find((w) => /^http:\/\/127\.0\.0\.1:\d+/.test(w.getURL()));
          if (wc) return { found: true, url: wc.getURL() };
          await new Promise((r) => setTimeout(r, 500));
        }
        return { found: false, url: '' };
      });
      expect(opened.found).toBe(true);
      expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

      // 3. 无凭据（临时 userData 无 provider 配置）：页面仍应完成渲染并显示输入区，
      //    而不是白屏/崩溃；实际 UI 允许用户随后在 pi 设置里补 Provider。
      await expect
        .poll(
          async () =>
            electronApp.evaluate(async ({ webContents }) => {
              const wc = webContents
                .getAllWebContents()
                .find((w) => /^http:\/\/127\.0\.0\.1:\d+/.test(w.getURL()));
              if (!wc) return false;
              try {
                return (await wc.executeJavaScript(`(() => {
                  const textarea = document.querySelector('textarea');
                  const tools = document.querySelector('.composer-tools');
                  return !!textarea && !!tools;
                })()`)) as boolean;
              } catch {
                return false;
              }
            }),
          { timeout: 45_000, intervals: [500, 1000, 2000] },
        )
        .toBe(true);

      // 4. 无凭据下的 WS 仍然握手成功（页面进入「已连接」）
      expect(await waitForConnected(electronApp)).toBe(true);

      // 5. 页面仍在运行（没有因无凭据崩掉）
      const stillAlive = await electronApp.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some((w) => /^http:\/\/127\.0\.0\.1:\d+/.test(w.getURL())),
      );
      expect(stillAlive).toBe(true);
    } finally {
      await electronApp.close();
    }
  });
});
