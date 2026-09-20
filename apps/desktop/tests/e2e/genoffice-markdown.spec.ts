/**
 * E2E：GenOffice Markdown 编辑器融合（阶段 2 打样）
 *
 * 覆盖路径：
 * 1. tab.create 打开 urchin://genoffice 伪地址 → 标签 viewKind=genoffice
 * 2. GenOffice 编辑器视图加载（genoffice-app:// 协议 + preload）并渲染文件内容
 * 3. 编辑器标签隐藏底部地址栏
 * 4. 编辑 → TabSnapshot.dirty（脏点数据源）→ 点击保存 → 磁盘回写 + dirty 回落
 * 5. 关闭标签（干净态：不触发原生三键对话框）
 *
 * 前置：`pnpm genoffice:build`（vendor 产物）；缺失时整组 skip，保证 CI 无 vendor
 * 构建时流水线不误红（打包/本地验收跑完整路径）。
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** vendor 嵌入产物（阶段 2 门禁） */
const GENOFFICE_EMBED = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'vendor',
  'genoffice',
  'apps',
  'urchin-embed',
  'out',
  'main',
  'index.js',
);

interface TabSnapshotLike {
  id: number;
  url: string;
  viewKind?: string;
  dirty?: boolean;
}

async function launchApp(): Promise<{
  electronApp: ElectronApplication;
  window: Page;
  userDataDir: string;
}> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-genoffice-'));

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

/** 渲染层 → 主进程 IPC（真实 preload 链路）。 */
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

async function listTabs(window: Page): Promise<TabSnapshotLike[]> {
  const res = (await invoke(window, 'tab.list', { windowId: 1 })) as unknown as {
    tabs: TabSnapshotLike[];
  };
  return res.tabs;
}

test.describe('GenOffice Markdown 编辑器（阶段 2 融合）', () => {
  test.skip(!existsSync(GENOFFICE_EMBED), 'vendor GenOffice 产物缺失：先执行 pnpm genoffice:build');

  test('打开 .md 走 GenOffice 编辑器：加载/编辑/保存/关闭', async () => {
    test.setTimeout(150_000);
    const { electronApp, window, userDataDir } = await launchApp();

    // 测试文档（临时 profile 内，避免污染）
    const docDir = join(userDataDir, 'docs');
    mkdirSync(docDir, { recursive: true });
    const mdPath = join(docDir, 'hello.md');
    writeFileSync(mdPath, '# Hello Urchin\n\n- one\n- two\n');

    // 1. 打开 GenOffice 伪地址
    const url = `urchin://genoffice/?kind=markdown&path=${encodeURIComponent(mdPath)}`;
    const created = await invoke(window, 'tab.create', { windowId: 1, url, active: true });
    const createdTab = (created as unknown as { tab: TabSnapshotLike }).tab;
    expect(createdTab.viewKind).toBe('genoffice');

    // 2. GenOffice 编辑器加载（协议 + preload + React 渲染文件内容）。
    //    轮询直到「编辑器挂载 + 文件内容渲染完成」——AI 初始化后启动路径变长，
    //    仅等 .ProseMirror 出现会命中空文档的中间态。
    const editor = await electronApp.evaluate(async ({ webContents }) => {
      for (let i = 0; i < 60; i++) {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getURL().startsWith('genoffice-app://markdown/'));
        if (wc) {
          try {
            const info = (await wc.executeJavaScript(
              `({ ready: !!document.querySelector('.ProseMirror'), text: document.querySelector('.ProseMirror')?.innerText ?? '' })`,
            )) as { ready: boolean; text: string };
            if (info.ready && info.text.includes('Hello Urchin')) return info;
          } catch {
            /* 页面尚未就绪：重试 */
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return { ready: false, text: '' };
    });
    expect(editor.ready).toBe(true);
    expect(editor.text).toContain('Hello Urchin');

    // 2.5 阶段 3：GenOffice 原生 AI 通道可用（编辑器 preload 桥真实取到设置）
    const aiSettings = await electronApp.evaluate(async ({ webContents }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('genoffice-app://markdown/'));
      return (await wc?.executeJavaScript(
        `window.markdownApi.getAiSettings().then((s) => ({ provider: s?.provider, hasProviders: !!s?.providers }))`,
      )) as { provider?: string; hasProviders?: boolean } | undefined;
    });
    expect(aiSettings?.provider).toBeTruthy();
    expect(aiSettings?.hasProviders).toBe(true);

    // 3. 编辑器标签隐藏底部地址栏（后退按钮不渲染）
    await expect(window.getByRole('button', { name: '后退' })).toHaveCount(0);

    // 4. 编辑 → 脏状态（侧栏脏点数据源 TabSnapshot.dirty）
    await electronApp.evaluate(async ({ webContents }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('genoffice-app://markdown/'));
      await wc?.executeJavaScript(`(() => {
        const pm = document.querySelector('.ProseMirror');
        if (!pm) return;
        pm.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(pm);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, '\\n\\nEDITED-BY-E2E');
      })()`);
    });
    await expect
      .poll(async () => (await listTabs(window)).find((t) => t.url === url)?.dirty, {
        timeout: 20_000,
      })
      .toBe(true);

    // 5. 点击编辑器「保存」→ 磁盘回写 + 脏状态回落（关闭时无需弹三键确认）
    await electronApp.evaluate(async ({ webContents }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('genoffice-app://markdown/'));
      await wc?.executeJavaScript(
        `(() => { const b = document.querySelector('button[aria-label^="保存"]'); if (b) b.click(); })()`,
      );
    });
    await expect
      .poll(async () => (await listTabs(window)).find((t) => t.url === url)?.dirty, {
        timeout: 20_000,
      })
      .toBe(false);
    expect(readFileSync(mdPath, 'utf-8')).toContain('EDITED-BY-E2E');

    // 6. 关闭标签（干净态）
    const tabId = (await listTabs(window)).find((t) => t.url === url)?.id;
    expect(tabId).toBeDefined();
    const closed = (await invoke(window, 'tab.close', { tabId })) as unknown as {
      closed: boolean;
    };
    expect(closed.closed).toBe(true);
    expect((await listTabs(window)).find((t) => t.id === tabId)).toBeUndefined();

    await electronApp.close();
  });

  test('设置页「AI（GenOffice）」可读写 ai-settings.json（BYOK）', async () => {
    test.setTimeout(120_000);
    const { electronApp, window, userDataDir } = await launchApp();

    // 打开设置页（React 渲染内部页）
    await invoke(window, 'tab.create', { windowId: 1, url: 'urchin://settings', active: true });

    // 切到 GenOffice AI 选项卡并等待目录加载
    await window.getByText('AI（GenOffice）').first().click();
    const providerSelect = window.getByLabel('服务商').first();
    await expect(providerSelect).toBeVisible({ timeout: 15_000 });

    // 默认设置是 genspark（无密钥输入）；切到任一「密钥型」BYOK 服务商
    //（codex 用 CLI 路径而非 API Key，跳过）
    const options = await providerSelect
      .locator('option')
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    const byok =
      ['anthropic', 'openai', 'deepseek', 'gemini'].find((v) => options.includes(v)) ??
      options.find((v) => v !== 'genspark' && v !== 'codex');
    expect(byok).toBeTruthy();
    await providerSelect.selectOption(byok!);

    // 填密钥并保存（首个「保存」= 模型服务卡片）
    await window.getByLabel('API Key').first().fill('sk-e2e-genoffice');
    await window.getByRole('button', { name: '保存' }).first().click();
    await expect(window.getByText('已保存').first()).toBeVisible({ timeout: 10_000 });

    // 主进程写入 <userData>/ai-settings.json（BYOK 明文 JSON，仅本机）
    const settingsPath = join(userDataDir, 'ai-settings.json');
    await expect
      .poll(
        () => {
          try {
            return readFileSync(settingsPath, 'utf-8');
          } catch {
            return '';
          }
        },
        { timeout: 10_000 },
      )
      .toContain('sk-e2e-genoffice');

    await electronApp.close();
  });

  test('左侧栏 GenOffice 入口打开上游 shell Home 前端（阶段 4.6）', async () => {
    test.setTimeout(120_000);
    const { electronApp, window } = await launchApp();

    // 侧栏入口：打开 GenOffice 文档入口（上游 shell Home 视图）
    await window.getByLabel('GenOffice 文档').click();

    // shell Home 视图加载：genoffice-app://shell/ + .home 根节点渲染
    const home = await electronApp.evaluate(async ({ webContents }) => {
      for (let i = 0; i < 60; i++) {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getURL().startsWith('genoffice-app://shell/'));
        if (wc) {
          try {
            const info = (await wc.executeJavaScript(
              `({ home: !!document.querySelector('.home'), text: (document.body.innerText || '').slice(0, 200) })`,
            )) as { home: boolean; text: string };
            if (info.home) return info;
          } catch {
            /* 页面尚未就绪：重试 */
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return { home: false, text: '' };
    });
    expect(home.home).toBe(true);

    // window.aiOffice 适配层真实可用：语言与最近列表经宿主通道往返
    const bridge = await electronApp.evaluate(async ({ webContents }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('genoffice-app://shell/'));
      return (await wc?.executeJavaScript(
        `Promise.all([window.aiOffice.getLanguage(), window.aiOffice.recents({ limit: 5 })]).then(([lang, page]) => ({ lang, entries: Array.isArray(page?.entries) ? page.entries.length : -1 }))`,
      )) as { lang?: string; entries?: number } | undefined;
    });
    expect(bridge?.lang).toBeTruthy();
    expect(bridge?.entries).toBeGreaterThanOrEqual(0);

    await electronApp.close();
  });
});
