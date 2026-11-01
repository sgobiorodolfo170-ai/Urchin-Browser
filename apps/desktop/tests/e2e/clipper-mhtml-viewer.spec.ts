/**
 * M26 MHTML 查看器 E2E：先用真实 Electron 生成 MHTML，再以文件参数启动应用，
 * 验证宿主只读查看器加载并解析出文档标题。
 *
 * 不依赖剪藏流程，直接验证 routeLocalFile 的 mhtml 分支与 Chromium MHTML 解析。
 */
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const APP_PATH = resolve(__dirname, '..', '..');
const MHTML_TITLE = 'MHTML 查看器测试';

function launchEnv(dataDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'production',
    PLAYWRIGHT: '1',
    URCHIN_TEST_USER_DATA: dataDir,
    URCHIN_TEST_DATA_DIR: dataDir,
    NODE_OPTIONS: '',
  };
}

async function generateMhtml(filePath: string): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'urchin-mhtml-gen-'));
  const app = await electron.launch({
    cwd: APP_PATH,
    args: ['.'],
    env: launchEnv(dataDir),
    timeout: 30_000,
  });
  try {
    await app.firstWindow();
    await app.evaluate(
      async ({ BrowserWindow }, args) => {
        const [target, title] = args as [string, string];
        const win = new BrowserWindow({
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><article><p>只读 MHTML 查看器正文</p></article></body></html>`;
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        await win.webContents.savePage(target, 'MHTML');
        win.destroy();
      },
      [filePath, MHTML_TITLE],
    );
  } finally {
    await app.close().catch(() => undefined);
  }
}

async function launchWithMhtml(
  filePath: string,
): Promise<{ app: ElectronApplication; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'urchin-mhtml-viewer-'));
  const app = await electron.launch({
    cwd: APP_PATH,
    args: ['.', filePath],
    env: launchEnv(dataDir),
    timeout: 30_000,
  });
  await app.firstWindow();
  return { app, dataDir };
}

test('MHTML 文件通过宿主只读查看器打开并解析标题', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'urchin-mhtml-file-'));
  const file = join(dir, 'viewer-test.mhtml');
  await generateMhtml(file);

  const { app } = await launchWithMhtml(file);
  try {
    await expect
      .poll(
        async () =>
          app.evaluate(({ webContents }) => {
            const target = webContents
              .getAllWebContents()
              .find((wc) => /\.mhtml(?:\?|$)/i.test(decodeURIComponent(wc.getURL())));
            return target ? { url: target.getURL(), title: target.getTitle() } : null;
          }),
        { timeout: 20_000 },
      )
      .toMatchObject({ title: MHTML_TITLE });
  } finally {
    await app.close().catch(() => undefined);
  }
});
