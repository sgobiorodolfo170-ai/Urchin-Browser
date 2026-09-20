/**
 * E2E：GenOffice 编辑器融合 · PDF / HTML / Docs(docx)（阶段 4）
 *
 * 覆盖路径（每格式：打开伪地址 → 对应编辑器加载并渲染文件 → 干净关闭）：
 * 1. HTML：CodeMirror 源码视图加载 + 预览 iframe（html-preview 协议）
 * 2. PDF：pdf.js 渲染出页面画布（pdfium/wasm 资源不在本用例路径上，渲染走 pdfjs）
 * 3. Docs：docx 解析进 Tiptap 文档（fixture 文本可见）
 *
 * 前置：`pnpm genoffice:build`（vendor 产物）；缺失时整组 skip。
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
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const VENDOR = resolve(__dirname, '..', '..', '..', '..', 'vendor', 'genoffice');
const GENOFFICE_EMBED = resolve(VENDOR, 'apps', 'urchin-embed', 'out', 'main', 'index.js');
const DOCX_FIXTURE = resolve(
  VENDOR,
  'apps',
  'docs',
  'tests',
  'pagination-corpus',
  'docx',
  '01-simple-english.docx',
);

interface TabSnapshotLike {
  id: number;
  url: string;
  viewKind?: string;
}

async function launchApp(): Promise<{
  electronApp: ElectronApplication;
  window: Page;
  userDataDir: string;
}> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-geneditors-'));
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
  return { electronApp, window, userDataDir };
}

async function invoke(
  window: Page,
  channel: string,
  req: unknown,
): Promise<Record<string, unknown>> {
  return window.evaluate(
    async (args: { channel: string; req: unknown }) =>
      (
        window as unknown as {
          urchin: { invoke: (c: string, r: unknown) => Promise<unknown> };
        }
      ).urchin.invoke(args.channel, args.req) as Promise<Record<string, unknown>>,
    { channel, req },
  );
}

/**
 * 打开 genoffice 伪地址并轮询对应编辑器 webContents，直到 predicate 求值为真。
 * predicate 是注入页面的表达式字符串（返回 boolean）。
 */
async function openAndWait(
  electronApp: ElectronApplication,
  window: Page,
  kind: string,
  filePath: string,
  appHost: string,
  predicate: string,
  timeoutMs = 60_000,
): Promise<{ tabId: number }> {
  const url = `urchin://genoffice/?kind=${encodeURIComponent(kind)}&path=${encodeURIComponent(filePath)}`;
  const created = (await invoke(window, 'tab.create', { windowId: 1, url, active: true })) as {
    tab: TabSnapshotLike;
  };
  expect(created.tab.viewKind).toBe('genoffice');

  const ready = await electronApp.evaluate(
    async ({ webContents }, args: { host: string; predicate: string; timeoutMs: number }) => {
      const deadline = Date.now() + args.timeoutMs;
      while (Date.now() < deadline) {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getURL().startsWith(`genoffice-app://${args.host}/`));
        if (wc) {
          try {
            const ok = (await wc.executeJavaScript(`!!(${args.predicate})`)) as boolean;
            if (ok) return true;
          } catch {
            /* 页面尚未就绪 */
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    },
    { host: appHost, predicate, timeoutMs },
  );
  expect(ready).toBe(true);
  return { tabId: created.tab.id };
}

async function closeTab(window: Page, tabId: number): Promise<void> {
  const closed = (await invoke(window, 'tab.close', { tabId })) as unknown as {
    closed: boolean;
  };
  expect(closed.closed).toBe(true);
}

test.describe('GenOffice 编辑器（阶段 4：PDF / HTML / Docs）', () => {
  test.skip(!existsSync(GENOFFICE_EMBED), 'vendor GenOffice 产物缺失：先执行 pnpm genoffice:build');

  test('HTML：CodeMirror 源码视图加载并渲染文件内容', async () => {
    test.setTimeout(150_000);
    const { electronApp, window, userDataDir } = await launchApp();

    const docDir = join(userDataDir, 'docs');
    mkdirSync(docDir, { recursive: true });
    const htmlPath = join(docDir, 'page.html');
    writeFileSync(htmlPath, '<!doctype html><h1>Urchin HTML Fixture</h1><p>hello</p>\n');

    const { tabId } = await openAndWait(
      electronApp,
      window,
      'html',
      htmlPath,
      'html',
      `document.querySelector('.cm-editor') && (document.querySelector('.cm-content')?.innerText || '').includes('Urchin HTML Fixture')`,
    );

    await closeTab(window, tabId);
    await electronApp.close();
  });

  test('PDF：pdf.js 渲染出页面画布', async () => {
    test.setTimeout(150_000);
    const { electronApp, window, userDataDir } = await launchApp();

    // 用 vendor 的 pdf-lib 生成一份最小 PDF（不依赖外部素材）
    const pdfLib = require(join(VENDOR, 'node_modules', 'pdf-lib')) as {
      PDFDocument: {
        create(): Promise<{
          addPage(size: [number, number]): {
            drawText(text: string, opts: Record<string, unknown>): void;
          };
          save(): Promise<Uint8Array>;
        }>;
      };
    };
    const docDir = join(userDataDir, 'docs');
    mkdirSync(docDir, { recursive: true });
    const pdfPath = join(docDir, 'fixture.pdf');
    const pdf = await pdfLib.PDFDocument.create();
    const page = pdf.addPage([595, 842]);
    page.drawText('Urchin PDF Fixture', { x: 60, y: 760, size: 18 });
    writeFileSync(pdfPath, await pdf.save());

    const { tabId } = await openAndWait(
      electronApp,
      window,
      'pdf',
      pdfPath,
      'pdf',
      `document.querySelectorAll('canvas').length > 0`,
    );

    await closeTab(window, tabId);
    await electronApp.close();
  });

  test('Docs：docx 解析进编辑器并渲染正文', async () => {
    test.setTimeout(150_000);
    const { electronApp, window, userDataDir } = await launchApp();

    expect(existsSync(DOCX_FIXTURE)).toBe(true);
    const docDir = join(userDataDir, 'docs');
    mkdirSync(docDir, { recursive: true });
    const docxPath = join(docDir, 'fixture.docx');
    copyFileSync(DOCX_FIXTURE, docxPath);

    const { tabId } = await openAndWait(
      electronApp,
      window,
      'docs',
      docxPath,
      'docs',
      `document.querySelector('.ProseMirror') && (document.querySelector('.ProseMirror')?.innerText || '').includes('Simple English Document')`,
    );

    await closeTab(window, tabId);
    await electronApp.close();
  });
});
