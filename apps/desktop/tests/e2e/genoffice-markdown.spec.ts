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

  test('文档首页设置弹窗「AI 模型」可读写 ai-settings.json（BYOK）', async () => {
    test.setTimeout(150_000);
    const { electronApp, window, userDataDir } = await launchApp();

    // 侧栏入口打开 shell Home 视图
    await window.getByLabel('GenOffice 文档').click();

    // 齿轮 → 设置弹窗 → AI 模型面板（默认区段）：选 BYOK 服务商 + 填密钥 + 保存
    const result = await electronApp.evaluate(async ({ webContents }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const getWc = () =>
        webContents
          .getAllWebContents()
          .find((w) => w.getURL().startsWith('genoffice-app://shell/'));
      const js = (code: string) => getWc()?.executeJavaScript(code);
      const wait = async (code: string, timeout: number): Promise<boolean> => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const ok = (await js(code)) as boolean | undefined;
          if (ok) return true;
          await sleep(300);
        }
        return false;
      };
      await wait(`!!document.querySelector('.account-entry button')`, 20_000);
      await js(`document.querySelector('.account-entry button').click()`);
      if (!(await wait(`!!document.querySelector('.set-dialog')`, 10_000))) {
        return { open: false, reason: 'no set-dialog' };
      }
      // 等 catalog 加载（deepseek 为 BYOK 服务商；默认区段 AI 模型面板）
      const catOk = await wait(
        `window.aiOffice.getAiProviders().then((c) => Array.isArray(c) && c.some((p) => p.id === 'deepseek'))`,
        15_000,
      );
      if (!catOk) {
        const providers = (await js(
          `window.aiOffice.getAiProviders().then((c) => (c ?? []).map((p) => p.id))`,
        )) as unknown;
        return { open: true, reason: `catalog no deepseek: ${JSON.stringify(providers)}` };
      }
      // 服务商下拉 → deepseek
      await js(`document.querySelector('.set-pane .gs-dd-btn')?.click()`);
      await wait(`!!document.querySelector('.gs-dd-item[data-value="deepseek"]')`, 5_000);
      await js(`document.querySelector('.gs-dd-item[data-value="deepseek"]')?.click()`);
      // 填密钥（React 受控输入：native setter + input 事件）
      if (!(await wait(`!!document.querySelector('#set-ai-key')`, 10_000))) {
        return { open: true, reason: 'no key input after provider change' };
      }
      const keySet = (await js(`(() => {
        const el = document.querySelector('#set-ai-key');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, 'sk-e2e-genoffice');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value === 'sk-e2e-genoffice';
      })()`)) as boolean;
      if (!keySet) return { open: true, reason: 'key not set' };
      await sleep(300);
      await js(`document.querySelector('.set-pane .set-btn.primary')?.click()`);
      await sleep(800);
      const saved = (await js(
        `(() => { const t = document.querySelector('.set-pane .set-ai-status')?.textContent ?? ''; return t; })()`,
      )) as string;
      return { open: true, done: true, saved };
    });
    expect(result?.reason).toBeUndefined();
    expect(result?.done).toBe(true);

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
    const { electronApp, window, userDataDir } = await launchApp();

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

    // 可见性断言（回归 2026-09-21 白屏）：shell Home 视图必须有真实 bounds
    // （此前 urchin://genoffice-home 被当作 React 内部页置零 → 挂载但不可见）
    const bounds = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const views = (win?.contentView?.children ?? []) as unknown as {
        webContents?: { getURL(): string };
        getBounds?(): { width: number; height: number };
      }[];
      const shellView = views.find((v) => {
        try {
          return v.webContents?.getURL().startsWith('genoffice-app://shell/') ?? false;
        } catch {
          return false;
        }
      });
      return shellView?.getBounds?.() ?? null;
    });
    expect(bounds?.width ?? 0).toBeGreaterThan(100);
    expect(bounds?.height ?? 0).toBeGreaterThan(100);

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

    // 上游 Home 的设置入口可正常打开设置弹窗（无账号面板，宿主桩不崩溃）
    const settingsModal = await electronApp.evaluate(async ({ webContents }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('genoffice-app://shell/'));
      const opened = (await wc?.executeJavaScript(`(() => {
        const entry = document.querySelector('.account-entry');
        const btn = entry?.querySelector('button');
        if (!btn) return false;
        btn.click();
        return true;
      })()`)) as boolean | undefined;
      if (!opened) return { opened: false, dialog: false };
      await new Promise((r) => setTimeout(r, 2000));
      const dialog = (await wc?.executeJavaScript(
        `!!document.querySelector('.set-dialog')`,
      )) as boolean;
      await wc?.executeJavaScript(`document.querySelector('.set-close')?.click()`);
      return { opened, dialog };
    });
    expect(settingsModal?.opened).toBe(true);
    expect(settingsModal?.dialog).toBe(true);

    // Home「新建 Markdown」动作：无路径的 genoffice 标签（空白文档）
    await electronApp.evaluate(async ({ webContents }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('genoffice-app://shell/'));
      await wc?.executeJavaScript(`window.aiOffice.newMarkdown()`);
    });
    await expect
      .poll(
        async () =>
          (await listTabs(window)).some((t) => t.url === 'urchin://genoffice/?kind=markdown'),
        { timeout: 20_000 },
      )
      .toBe(true);

    // Home「打开本地文件」真实链路：window.aiOffice.openPath → genoffice 编辑器标签
    const docDir = join(userDataDir, 'docs');
    mkdirSync(docDir, { recursive: true });
    const homeMd = join(docDir, 'from-home.md');
    writeFileSync(homeMd, '# From Home\n\n- via aiOffice.openPath\n');
    await electronApp.evaluate(async ({ webContents }, filePath) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('genoffice-app://shell/'));
      await wc?.executeJavaScript(`window.aiOffice.openPath(${JSON.stringify(filePath)})`);
    }, homeMd);
    await expect
      .poll(
        async () =>
          (await listTabs(window)).some(
            (t) => t.viewKind === 'genoffice' && t.url.includes('kind=markdown'),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);

    // 最近列表已记录（Home 的「最近」数据源）
    const recent = await electronApp.evaluate(async ({ webContents }, filePath) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('genoffice-app://shell/'));
      return (await wc?.executeJavaScript(
        `window.aiOffice.recents({ limit: 10 }).then((p) => (p?.entries ?? []).some((e) => e.path === ${JSON.stringify(filePath)}))`,
      )) as boolean | undefined;
    }, homeMd);
    expect(recent).toBe(true);

    // Home「新建 Word」动作：空白 docs 视图（genoffice 标签）
    await electronApp.evaluate(async ({ webContents }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('genoffice-app://shell/'));
      await wc?.executeJavaScript(`window.aiOffice.newDoc()`);
    });
    await expect
      .poll(
        async () => (await listTabs(window)).some((t) => t.url === 'urchin://genoffice/?kind=docs'),
        { timeout: 20_000 },
      )
      .toBe(true);

    await electronApp.close();
  });

  test('降级开关 URCHIN_DISABLE_GENOFFICE=1：伪地址改写为内置查看器', async () => {
    test.setTimeout(60_000);
    const appPath = resolve(__dirname, '..', '..');
    const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-genoffice-off-'));
    const electronApp = await electron.launch({
      cwd: appPath,
      args: ['.'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PLAYWRIGHT: '1',
        URCHIN_TEST_USER_DATA: userDataDir,
        URCHIN_DISABLE_GENOFFICE: '1',
        NODE_OPTIONS: '',
      },
      timeout: 30_000,
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');

      const docDir = join(userDataDir, 'docs');
      mkdirSync(docDir, { recursive: true });
      const md = join(docDir, 'off.md');
      writeFileSync(md, '# off\n');

      await invoke(window, 'tab.create', {
        windowId: 1,
        url: `urchin://genoffice/?kind=markdown&path=${encodeURIComponent(md)}`,
      });
      await expect
        .poll(
          async () =>
            (await listTabs(window)).some(
              (t) => t.url === `urchin://file-viewer/?path=${encodeURIComponent(md)}`,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      const tabs = await listTabs(window);
      expect(tabs.some((t) => t.viewKind === 'genoffice')).toBe(false);
    } finally {
      await electronApp.close();
    }
  });
});
