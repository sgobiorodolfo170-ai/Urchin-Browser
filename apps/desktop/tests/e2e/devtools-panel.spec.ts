/**
 * E2E 测试：M15 DevTools 检视列（dev.119，CDP 采集面板一期）
 *
 * 覆盖路径（实施规划 §10.2，简化为 IPC 级验证，F12/UI 交互由人工验收）：
 * 1. devtools.status 返回 detached（无会话）
 * 2. devtools.attach 对内部页返回 unavailable(internal-page)
 * 3. data: URL 标签 attach 成功 → evaluate → consoleAPICalled 端到端
 * 4. detach 后 status 回 detached
 *
 * F12 键盘拦截与面板渲染属 UI 交互层，受 Playwright CDP 与 before-input-event
 * 时序影响较大，由人工验收清单承担（见规划 §10.3 Spike 结论）。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test.describe('M15 DevTools 检视列', () => {
  test('devtools.status 对无会话返回 detached', async () => {
    const appPath = resolve(__dirname, '..', '..');
    const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-devtools-e2e-'));
    const electronApp = await electron.launch({
      cwd: appPath,
      args: ['.'],
      env: { ...process.env, NODE_ENV: 'production', URCHIN_TEST_USER_DATA: userDataDir },
      timeout: 60_000,
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await window.waitForTimeout(1000);

      const status = await window.evaluate(async () => {
        const w = window as unknown as {
          urchin: { invoke: (ch: string, req: unknown) => Promise<unknown> };
        };
        return w.urchin.invoke('devtools.status', { tabId: 1 });
      });
      expect(status).toEqual({ state: 'detached' });
    } finally {
      await electronApp.close();
    }
  });

  test('devtools.attach 对内部页返回 unavailable(internal-page)', async () => {
    const appPath = resolve(__dirname, '..', '..');
    const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-devtools-e2e-'));
    const electronApp = await electron.launch({
      cwd: appPath,
      args: ['.'],
      env: { ...process.env, NODE_ENV: 'production', URCHIN_TEST_USER_DATA: userDataDir },
      timeout: 60_000,
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await window.waitForTimeout(1000);

      // 内部页 tab（urchin://newtab，tabId=1 是初始 tab）attach 应拒绝
      const res = await window.evaluate(async () => {
        const w = window as unknown as {
          urchin: { invoke: (ch: string, req: unknown) => Promise<unknown> };
        };
        return w.urchin.invoke('devtools.attach', { tabId: 1 });
      });
      const r = res as { state: string; reason?: string };
      expect(r.state).toBe('unavailable');
      expect(r.reason).toBe('internal-page');
    } finally {
      await electronApp.close();
    }
  });

  test('data: URL 标签 attach + evaluate + consoleAPICalled 端到端', async () => {
    const appPath = resolve(__dirname, '..', '..');
    const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-devtools-e2e-'));
    const electronApp = await electron.launch({
      cwd: appPath,
      args: ['.'],
      env: { ...process.env, NODE_ENV: 'production', URCHIN_TEST_USER_DATA: userDataDir },
      timeout: 60_000,
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await window.waitForTimeout(1000);

      // 创建 data: URL 标签（可检视）
      const createRes = await window.evaluate(async () => {
        const w = window as unknown as {
          urchin: { invoke: (ch: string, req: unknown) => Promise<unknown> };
        };
        return w.urchin.invoke('tab.create', {
          windowId: 1,
          url: 'data:text/html,<script>console.warn("urchin-e2e-warn")</script>',
          active: true,
        });
      });
      const created = createRes as { tab: { id: number } };
      const dataTabId = created.tab.id;

      // attach 应成功
      const attachRes = await window.evaluate(async (tabId: number) => {
        const w = window as unknown as {
          urchin: { invoke: (ch: string, req: unknown) => Promise<unknown> };
        };
        return w.urchin.invoke('devtools.attach', { tabId });
      }, dataTabId);
      const ar = attachRes as { state: string; target?: { tabId: number } };
      expect(ar.state).toBe('attached');
      expect(ar.target?.tabId).toBe(dataTabId);

      // 等待 consoleAPICalled 批处理（200ms）→ console.list 出现 warn 输出
      await window.waitForTimeout(1000);
      const conRes = await window.evaluate(async (tabId: number) => {
        const w = window as unknown as {
          urchin: { invoke: (ch: string, req: unknown) => Promise<unknown> };
        };
        return w.urchin.invoke('devtools.console.list', { tabId });
      }, dataTabId);
      const con = conRes as { entries: { text: string; level: string }[]; dropped: number };
      expect(con.entries.length).toBeGreaterThan(0);
      expect(con.entries.some((e) => e.text.includes('urchin-e2e-warn'))).toBe(true);

      // evaluate console.error → console.list 新增
      const evalRes = await window.evaluate(async (tabId: number) => {
        const w = window as unknown as {
          urchin: { invoke: (ch: string, req: unknown) => Promise<unknown> };
        };
        return w.urchin.invoke('devtools.evaluate', {
          tabId,
          expression: "console.error('urchin-e2e-eval')",
        });
      }, dataTabId);
      const ev = evalRes as { ok: boolean };
      expect(ev.ok).toBe(true);

      await window.waitForTimeout(1000);
      const conRes2 = await window.evaluate(async (tabId: number) => {
        const w = window as unknown as {
          urchin: { invoke: (ch: string, req: unknown) => Promise<unknown> };
        };
        return w.urchin.invoke('devtools.console.list', { tabId });
      }, dataTabId);
      const con2 = conRes2 as { entries: { text: string }[] };
      expect(con2.entries.some((e) => e.text.includes('urchin-e2e-eval'))).toBe(true);

      // detach → status 回 detached
      await window.evaluate(async (tabId: number) => {
        const w = window as unknown as {
          urchin: { invoke: (ch: string, req: unknown) => Promise<unknown> };
        };
        return w.urchin.invoke('devtools.detach', { tabId });
      }, dataTabId);
      const statusRes = await window.evaluate(async (tabId: number) => {
        const w = window as unknown as {
          urchin: { invoke: (ch: string, req: unknown) => Promise<unknown> };
        };
        return w.urchin.invoke('devtools.status', { tabId });
      }, dataTabId);
      const sr = statusRes as { state: string };
      expect(sr.state).toBe('detached');
    } finally {
      await electronApp.close();
    }
  });
});
