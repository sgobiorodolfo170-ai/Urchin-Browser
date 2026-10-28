/**
 * E2E：pi 阶段 2 自研托管服务链路（docs/pi-web-评估.md 阶段 2 / M2A 骨架）
 *
 * 验证「自研前端 + utilityProcess 托管服务」整链路：
 * 1. 真实 Electron 启动（不 mock）→ 渲染层 preload→IPC 调用 piWebHost.launch
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

test.describe('pi 阶段 2 自研托管服务（M2A 骨架）', () => {
  test('launch → 鉴权 URL → 前端加载 + WS 握手 → 退出杀进程', async () => {
    test.setTimeout(150_000);
    const { electronApp, window } = await launchApp();

    // 1. 启动托管服务（渲染层 → 主进程 IPC → utilityProcess.fork）
    const launchRes = (await invoke(window, 'piWebHost.launch', {})) as {
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
      const status = (await invoke(window, 'piWebHost.status', {})) as {
        state: string;
        url?: string;
      };
      expect(status.state).toBe('running');
      expect(status.url).toBe(url);

      // 3. 鉴权：带 token 200，无 token 401
      expect(await probe(url)).toBe(200);
      expect(await probe(`http://127.0.0.1:${launchRes.port}/`)).toBe(401);

      // 4. 带 token 页面内容为自研前端
      const body = await (await fetch(url)).text();
      expect(body).toContain('pi · Urchin（阶段 2）');

      // 5. 在标签页打开自研前端 → WebSocket hello_ok → 「已握手」UI
      await invoke(window, 'tab.create', {
        windowId: 1,
        url,
        active: true,
      });

      // 用 webContents 定位 BrowserView 页面（创建有异步窗口，需逐步刷新列表）
      //  并轮询握手 UI：页面标题命中 + body 出现「已握手」（hello_ok 已返回）
      const result = await electronApp.evaluate(
        async ({ webContents }, { basePort }): Promise<boolean> => {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            const wc = webContents
              .getAllWebContents()
              .find((w) => w.getURL().startsWith(`http://127.0.0.1:${basePort}`));
            if (wc) {
              const state = (await wc
                .executeJavaScript(
                  `(() => ({
                    title: document.title,
                    text: document.body ? document.body.innerText : ''
                  }))()`,
                  true,
                )
                .catch(() => null)) as { title?: unknown; text?: unknown } | null;
              const title = typeof state?.title === 'string' ? state.title : '';
              const text = typeof state?.text === 'string' ? state.text : '';
              if (title.includes('pi · Urchin') && text.includes('已握手')) {
                return true;
              }
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          return false;
        },
        { basePort: launchRes.port },
      );
      expect(result).toBe(true);
    } finally {
      // 6. 关闭应用 → utility 子进程随 performCleanup 终止 → 端口不可达
      await electronApp.close();
    }

    expect(await probe(url).catch(() => 0)).toBe(0);
    expect(await probe(`http://127.0.0.1:${launchRes.port}/`).catch(() => 0)).toBe(0);
  });
});
