/**
 * E2E 测试：网页翻译（M24 dev.82）
 *
 * 覆盖路径（规划 §8.2，引擎端点 mock、页面不 mock）：
 * 1. 本地假翻译服务同时提供 fixture 页面（英文）与双引擎端点（确定性标记译文「【译】」）
 * 2. 启动应用 → 导航到 fixture 页 → 点地址栏翻译按钮
 * 3. 断言 BrowserView 正文出现标记译文 + 按钮态切换为「恢复原文」
 * 4. 点「恢复原文」→ 断言正文还原为英文原文
 *
 * 引擎注入：URCHIN_TRANSLATE_TEST_BASE 环境变量（index.ts 装配方支持）。
 * 真实网络（国内微软引擎可用性等）不在 E2E 覆盖范围，由手工验收清单承担。
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

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Translate Fixture</title></head>
<body>
  <h1>Hello beautiful world</h1>
  <p>This paragraph is written in English for translation testing.</p>
</body>
</html>`;

/**
 * 本地假翻译服务：
 * - GET  /fixture                    → 英文 fixture 页面
 * - GET  /microsoft/auth             → 确定性 token
 * - POST /microsoft/translate        → 按微软响应形态返回「【译】+原文」
 * - POST /google/translate_a/t       → 按谷歌批量形态返回「【译】+原文」
 */
function startFakeTranslateServer(): Promise<{
  server: Server;
  port: number;
  hits: Map<string, number>;
}> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    hits.set(
      `${req.method} ${url.split('?')[0]}`,
      (hits.get(`${req.method} ${url.split('?')[0]}`) ?? 0) + 1,
    );
    if (req.method === 'GET' && url.startsWith('/fixture')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(FIXTURE_HTML);
      return;
    }
    if (req.method === 'GET' && url.startsWith('/microsoft/auth')) {
      res.setHeader('Content-Type', 'text/plain');
      res.end('e2e-token');
      return;
    }
    if (req.method === 'POST' && url.startsWith('/microsoft/translate')) {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const items = JSON.parse(body || '[]') as { Text: string }[];
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            items.map((i) => ({
              detectedLanguage: { language: 'en' },
              translations: [{ text: `【译】${i.Text}`, to: 'zh-Hans' }],
            })),
          ),
        );
      });
      return;
    }
    if (req.method === 'POST' && url.startsWith('/google/translate_a/t')) {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const q = new URLSearchParams(body).getAll('q');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(q.map((t) => `【译】${t}`)));
      });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, port, hits });
    });
  });
}

/** 启动 Electron 应用（注入假翻译服务基址） */
async function launchApp(
  env: Record<string, string>,
): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-translate-'));
  const electronApp = await electron.launch({
    cwd: appPath,
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYWRIGHT: '1',
      URCHIN_TEST_USER_DATA: userDataDir,
      NODE_OPTIONS: '',
      ...env,
    },
    timeout: 30_000,
  });
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.locator('[aria-label="右侧边栏"]').first().dblclick();
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  return { electronApp, window };
}

/** 读取首个 BrowserView 的页面正文（翻译替换发生在页面世界，UI 只见 toast/按钮态） */
function getBrowserViewText(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win?.getBrowserViews()[0];
    if (!view) return Promise.resolve('');
    return view.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
  });
}

test.describe('网页翻译', () => {
  test('should translate the page and restore the original text via omnibox button', async () => {
    const { server, port } = await startFakeTranslateServer();
    const { electronApp, window } = await launchApp({
      URCHIN_TRANSLATE_TEST_BASE: `http://127.0.0.1:${port}`,
    });

    try {
      // 导航到本地 fixture 页
      const omniboxInput = window.getByRole('textbox').first();
      await omniboxInput.fill(`http://127.0.0.1:${port}/fixture`);
      await omniboxInput.press('Enter');
      await expect(omniboxInput).toHaveValue(new RegExp(`127\\.0\\.0\\.1:${port}`), {
        timeout: 15_000,
      });

      // 等 fixture 页面真正加载完成（正文可见）再触发翻译，排除加载竞态
      await expect
        .poll(() => getBrowserViewText(electronApp), { timeout: 20_000 })
        .toContain('Hello beautiful world');

      const translateButton = window.getByRole('button', { name: '翻译网页' });
      await translateButton.click({ timeout: 15_000 });

      // 正文出现确定性标记译文 + 按钮切换为「恢复原文」
      await expect
        .poll(() => getBrowserViewText(electronApp), { timeout: 20_000 })
        .toContain('【译】Hello beautiful world');
      await expect(window.getByRole('button', { name: '恢复原文' })).toBeVisible({
        timeout: 10_000,
      });

      // 恢复原文：正文还原 + 按钮态切回
      await window.getByRole('button', { name: '恢复原文' }).click();
      await expect
        .poll(() => getBrowserViewText(electronApp), { timeout: 20_000 })
        .toContain('Hello beautiful world');
      await expect(window.getByRole('button', { name: '翻译网页' })).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await electronApp.close();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });
});
