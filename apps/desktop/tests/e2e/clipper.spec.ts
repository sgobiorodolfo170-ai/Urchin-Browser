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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStatusBarPage, waitForShellReady } from './helpers/status-bar';
import {
  readBytes,
  readText,
  waitForClipFile,
  waitForClipperPanelReady,
  waitForClipperSaveSettled,
} from './helpers/clipper';

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

    // 剪藏面板是独立 BrowserWindow；等到内容区首次渲染完成（标题可见 + 保存可用）。
    const panel = await waitForClipperPanelReady(app);

    await panel.getByRole('button', { name: '保存' }).click();

    const clipDir = join(dataDir, 'data', 'documents', 'clipper');
    // 文件存在 ≠ 内容写完：等到正文真正落盘（见 helpers/clipper.ts 顶部取证）。
    const mdFile = await waitForClipFile(clipDir, '.md', (path) =>
      readText(path).includes('剪藏测试文章'),
    );
    const content = readText(mdFile);
    expect(content).toContain('剪藏测试文章');
    expect(content).toContain('正文段落');
    expect(content).toContain('source: "http://127.0.0.1');
    expect(content).toContain('闭 Shadow DOM 正文');
    expect(content).toContain('img.svg');
    await waitForClipperSaveSettled(app);

    // 再剪一次为 MHTML，验证 Chromium 原生快照落盘。
    await omnibox.getByRole('button', { name: '剪藏' }).click();
    const mhtmlPanel = await waitForClipperPanelReady(app);
    await mhtmlPanel.getByLabel('保存格式').selectOption('mhtml');
    await mhtmlPanel.getByRole('button', { name: '保存' }).click();

    // MHTML 由 savePage 先建文件再写内容，必须等 MIME 头出现再断言整体内容。
    const mhtmlFile = await waitForClipFile(clipDir, '.mhtml', (path) =>
      readText(path).includes('MIME-Version'),
    );
    const mhtml = readText(mhtmlFile);
    expect(mhtml).toContain('MIME-Version');
    expect(mhtml).toContain('multipart/related');
    expect(mhtml).toMatch(/Content-Type: image\/svg\+xml/i);
    await waitForClipperSaveSettled(app);

    // PDF 快照
    await omnibox.getByRole('button', { name: '剪藏' }).click();
    const pdfPanel = await waitForClipperPanelReady(app);
    await pdfPanel.getByLabel('保存格式').selectOption('pdf');
    await pdfPanel.getByRole('button', { name: '保存' }).click();
    const pdfFile = await waitForClipFile(clipDir, '.pdf', (path) => readBytes(path) > 500);
    expect(readBytes(pdfFile)).toBeGreaterThan(500);
    await waitForClipperSaveSettled(app);

    // 整页截图
    await omnibox.getByRole('button', { name: '剪藏' }).click();
    const shotPanel = await waitForClipperPanelReady(app);
    await shotPanel.getByLabel('保存格式').selectOption('screenshot');
    await shotPanel.getByRole('button', { name: '保存' }).click();
    const shotFile = await waitForClipFile(clipDir, '.png', (path) => readBytes(path) > 100);
    expect(readBytes(shotFile)).toBeGreaterThan(100);
  } finally {
    await app.close().catch(() => undefined);
    await new Promise<void>((done) => server.close(() => done()));
  }
});
