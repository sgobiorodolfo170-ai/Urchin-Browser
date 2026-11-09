/**
 * M26 剪藏 E2E：本地文章页 → 地址栏剪藏 → 面板保存 Markdown → 文件落盘。
 *
 * 使用本地 HTTP 服务，避免依赖外网；数据目录隔离到临时目录，
 * 直接断言 <dataDir>/documents/clipper/*.md 内容。
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStatusBarPage, waitForShellReady } from './helpers/status-bar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ARTICLE_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>剪藏测试文章</title><meta name="author" content="Urchin"></head>
<body><nav>导航不要</nav><article><h1>剪藏测试文章</h1>
<p>这是用于剪藏 E2E 的正文段落，包含足够多的文字以通过正文抽取。</p>
<p>第二段：验证 Defuddle 能识别 article 并生成 Markdown。</p>
<p><img src="/img.svg" alt="测试图片" width="600" height="400"></p>
</article><footer>页脚不要</footer>
<script>
  // 闭 Shadow DOM：页面脚本拿不到 shadowRoot，必须由主进程 CDP 兜底。
  var host = document.createElement('div');
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<p>闭 Shadow DOM 正文</p>';
</script>
</body></html>`;

/** 1x1 PNG（保留以兼容旧断言，当前图文页使用 SVG） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6j1WQAAAABJRU5ErkJggg==';

const IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#4f46e5"/><text x="40" y="200" fill="white" font-size="48">Clipper</text></svg>';

async function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === '/img.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      res.end(IMAGE_SVG);
      return;
    }
    if (req.url === '/img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(Buffer.from(PNG_BASE64, 'base64'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ARTICLE_HTML);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port };
}

async function launchApp(dataDir: string): Promise<{ app: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const app = await electron.launch({
    cwd: appPath,
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYWRIGHT: '1',
      URCHIN_TEST_USER_DATA: dataDir,
      URCHIN_TEST_DATA_DIR: dataDir,
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  // 壳就绪后再找悬浮层：悬浮层由渲染层首帧后的 ui.statusbar.sync 懒创建（见 helper 注释）
  await waitForShellReady(window);
  return { app, window };
}

async function waitForClipperPanel(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const panel = app.windows().find((p) => {
      try {
        return new URL(p.url()).searchParams.get('view') === 'clipper';
      } catch {
        return false;
      }
    });
    if (panel) {
      await panel.waitForLoadState('domcontentloaded');
      await expect(panel.getByText('剪藏（Clipper）')).toBeVisible({ timeout: 20_000 });
      return panel;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('clipper panel window not found');
}

async function waitForFile(dir: string, ext: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(dir)) {
      const file = readdirSync(dir).find((name) => name.endsWith(ext));
      if (file) return join(dir, file);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`clip file ${ext} not found in ${dir}`);
}

test('剪藏面板保存 Markdown 到 documents/clipper', async () => {
  const { server, port } = await startServer();
  const dataDir = mkdtempSync(join(tmpdir(), 'urchin-clipper-e2e-'));
  const { app, window } = await launchApp(dataDir);
  try {
    const omnibox = await getStatusBarPage(app, 20_000);
    const input = omnibox.getByRole('textbox', { name: '地址栏' });
    await input.waitFor({ state: 'visible', timeout: 20_000 });
    await input.fill(`http://127.0.0.1:${port}/`);
    await input.press('Enter');
    await expect(
      window.getByRole('button', { name: /切换到标签.*剪藏测试文章/ }).first(),
    ).toBeVisible({ timeout: 15_000 });

    await omnibox.getByRole('button', { name: '剪藏' }).click();

    // 剪藏面板是独立 BrowserWindow；等待 view=clipper 窗口出现。
    const panel = await waitForClipperPanel(app);

    await panel.getByRole('button', { name: '保存' }).click();

    const clipDir = join(dataDir, 'data', 'documents', 'clipper');
    const fileDeadline = Date.now() + 15_000;
    while (Date.now() < fileDeadline && !existsSync(clipDir)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(clipDir)).toBeTruthy();
    const files = readdirSync(clipDir).filter((name) => name.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    const content = readFileSync(join(clipDir, files[0]!), 'utf-8');
    expect(content).toContain('剪藏测试文章');
    expect(content).toContain('正文段落');
    expect(content).toContain('source: "http://127.0.0.1');
    expect(content).toContain('闭 Shadow DOM 正文');
    expect(content).toContain('img.svg');

    // 再剪一次为 MHTML，验证 Chromium 原生快照落盘。
    await new Promise((r) => setTimeout(r, 1_500));
    await omnibox.getByRole('button', { name: '剪藏' }).click();
    const mhtmlPanel = await waitForClipperPanel(app);
    await mhtmlPanel.getByLabel('保存格式').selectOption('mhtml');
    await mhtmlPanel.getByRole('button', { name: '保存' }).click();

    const mhtmlDeadline = Date.now() + 20_000;
    let mhtmlFiles: string[] = [];
    while (Date.now() < mhtmlDeadline) {
      if (existsSync(clipDir)) {
        mhtmlFiles = readdirSync(clipDir).filter((name) => name.endsWith('.mhtml'));
        if (mhtmlFiles.length > 0) break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(mhtmlFiles.length).toBeGreaterThan(0);
    const mhtml = readFileSync(join(clipDir, mhtmlFiles[0]!), 'utf-8');
    expect(mhtml).toContain('MIME-Version');
    expect(mhtml).toContain('multipart/related');
    expect(mhtml).toMatch(/Content-Type: image\/svg\+xml/i);

    // PDF 快照
    await new Promise((r) => setTimeout(r, 1_500));
    await omnibox.getByRole('button', { name: '剪藏' }).click();
    const pdfPanel = await waitForClipperPanel(app);
    await pdfPanel.getByLabel('保存格式').selectOption('pdf');
    await pdfPanel.getByRole('button', { name: '保存' }).click();
    const pdfFile = await waitForFile(clipDir, '.pdf');
    expect(readFileSync(pdfFile).byteLength).toBeGreaterThan(500);

    // 整页截图
    await new Promise((r) => setTimeout(r, 1_500));
    await omnibox.getByRole('button', { name: '剪藏' }).click();
    const shotPanel = await waitForClipperPanel(app);
    await shotPanel.getByLabel('保存格式').selectOption('screenshot');
    await shotPanel.getByRole('button', { name: '保存' }).click();
    const shotFile = await waitForFile(clipDir, '.png');
    expect(readFileSync(shotFile).byteLength).toBeGreaterThan(100);
  } finally {
    await app.close().catch(() => undefined);
    await new Promise<void>((done) => server.close(() => done()));
  }
});
