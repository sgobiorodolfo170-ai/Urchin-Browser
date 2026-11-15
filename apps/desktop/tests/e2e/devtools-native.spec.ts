/** ADR-022 P0-B：通过真实键盘输入通路验证原生工具，不调用内部 toggle。 */
import { test, electron } from './helpers/electron-test';
import { expect, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function input(app: ElectronApplication, id: number, nativeTool = false): Promise<void> {
  if (nativeTool) {
    // isDevToolsOpened 可早于前端脚本完成；输入必须等待该窗口的键盘适配就绪。
    await expect
      .poll(() =>
        app.evaluate(async ({ webContents }, wcId) => {
          const ready: unknown = await webContents
            .fromId(wcId)!
            .executeJavaScript('typeof globalThis.__urchinDisposeF12 === "function"');
          return ready === true;
        }, id),
      )
      .toBe(true);
  }
  await app.evaluate(({ webContents }, wcId) => webContents.fromId(wcId)!.focus(), id);
  await expect
    .poll(() =>
      app.evaluate(({ webContents }, wcId) => webContents.fromId(wcId)?.isFocused() ?? false, id),
    )
    .toBe(true);
  await app.evaluate(({ webContents }, wcId) => {
    webContents.fromId(wcId)!.sendInputEvent({ type: 'keyDown', keyCode: 'F12' });
  }, id);
  // KeyDown can move focus or destroy the tool. Release through the new focus,
  // just as a physical keyUp does, rather than sending it to a stale renderer.
  await app.evaluate(({ webContents }) => {
    webContents.getFocusedWebContents()?.sendInputEvent({ type: 'keyUp', keyCode: 'F12' });
  });
}
async function state(app: ElectronApplication, id: number) {
  return app.evaluate(({ webContents }, wcId) => {
    const wc = webContents.fromId(wcId);
    return {
      open: wc?.isDevToolsOpened() ?? false,
      toolId: wc?.devToolsWebContents?.id ?? null,
      attached: wc?.debugger.isAttached() ?? false,
    };
  }, id);
}

async function toolId(app: ElectronApplication, targetId: number): Promise<number> {
  // Windows can report opened before devToolsWebContents has been published.
  let id: number | null = null;
  await expect
    .poll(async () => {
      const current = await state(app, targetId);
      id = current.toolId;
      return current.open && id !== null;
    })
    .toBe(true);
  return id!;
}

test('native F12: shell/page/tool, fixed targets, manual close and 20 cycles', async () => {
  test.setTimeout(120_000);
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<title>native fixture ${req.url}</title><h1 id="fixture">Native fixture</h1><script>window.fixtureValue=42;window.f12Count=0;addEventListener('keydown',e=>{if(e.key==='F12')window.f12Count++})</script>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server unavailable');
  const profile = mkdtempSync(join(tmpdir(), 'urchin-native-e2e-'));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      cwd: resolve(import.meta.dirname, '../..'),
      args: ['.'],
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PLAYWRIGHT: '1',
        URCHIN_TEST_USER_DATA: profile,
        URCHIN_TEST_DATA_DIR: join(profile, 'data'),
        NODE_OPTIONS: '',
      },
    });
    const shell = await app.firstWindow();
    await shell.waitForLoadState('domcontentloaded');
    const shellId = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('/renderer/index.html'),
        )!.webContents.id,
    );
    const current = (await shell.evaluate(() => window.urchin.invoke('window.getCurrent', {}))) as {
      windowId: number;
    };
    const url = `http://127.0.0.1:${address.port}/a`;
    const created = (await shell.evaluate(
      ({ windowId, url }) => window.urchin.invoke('tab.create', { windowId, url, active: true }),
      { windowId: current.windowId, url },
    )) as { tab: { id: number } };
    await expect
      .poll(() =>
        app!.evaluate(
          ({ webContents }, url) =>
            webContents
              .getAllWebContents()
              .find((w) => w.getURL() === url)
              ?.isLoading(),
          url,
        ),
      )
      .toBe(false);
    const a = await app.evaluate(
      ({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.id,
      url,
    );
    await input(app, shellId);
    await expect.poll(() => state(app!, a).then((s) => s.open)).toBe(true);
    expect((await state(app, a)).attached).toBe(false);
    const toolA = await toolId(app, a);
    // 原生 UI 实际加载并显示多个面板，不以 opened=true 单独判成功。
    await expect
      .poll(() =>
        app!.evaluate(async ({ webContents }, id) => {
          const labels: unknown = await webContents.fromId(id)!.executeJavaScript(`(() => {
      const labels=[]; const visit=root=>{for(const el of root.querySelectorAll('*')){if(el.getAttribute('role')==='tab')labels.push(el.textContent);if(el.shadowRoot)visit(el.shadowRoot)}}; visit(document); return labels.join('|');
    })()`);
          return typeof labels === 'string' ? labels : '';
        }, toolA),
      )
      .toContain('Console');
    // B 打开后 A 工具不能改绑；A 工具 F12 只能关闭 A。
    await shell.evaluate(
      ({ windowId, url }) => window.urchin.invoke('tab.create', { windowId, url, active: true }),
      { windowId: current.windowId, url: `http://127.0.0.1:${address.port}/b` },
    );
    const bUrl = `http://127.0.0.1:${address.port}/b`;
    await expect
      .poll(() =>
        app!.evaluate(
          ({ webContents }, url) =>
            webContents
              .getAllWebContents()
              .find((w) => w.getURL() === url)
              ?.isLoading(),
          bUrl,
        ),
      )
      .toBe(false);
    const b = await app.evaluate(
      ({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.id,
      bUrl,
    );
    await input(app, b);
    await expect.poll(() => state(app!, b).then((s) => s.open)).toBe(true);
    await input(app, toolA, true);
    await expect.poll(() => state(app!, a).then((s) => s.open)).toBe(false);
    expect((await state(app, b)).open).toBe(true);
    await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.closeDevTools(), b);
    await expect.poll(() => state(app!, b).then((s) => s.open)).toBe(false);
    await shell.evaluate(
      (tabId) => window.urchin.invoke('tab.setActive', { tabId }),
      created.tab.id,
    );
    // 地址栏是真正的独立悬浮窗口，不等价于主 renderer 的键盘焦点。
    await expect
      .poll(() =>
        app!.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Urchin Status Bar')
              ?.webContents.id,
        ),
      )
      .toBeTruthy();
    const barId = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Urchin Status Bar')!.webContents
          .id,
    );
    await input(app, barId);
    await expect.poll(() => state(app!, a).then((s) => s.open)).toBe(true);
    await input(app, await toolId(app, a), true);
    await expect.poll(() => state(app!, a).then((s) => s.open)).toBe(false);
    for (let i = 0; i < 20; i++) {
      await input(app, a);
      await expect.poll(() => state(app!, a).then((s) => s.open)).toBe(true);
      const tool = await toolId(app, a);
      await input(app, tool, true);
      await expect.poll(() => state(app!, a).then((s) => s.open)).toBe(false);
    }
    await expect.poll(() => state(app!, a)).toEqual({ open: false, toolId: null, attached: false });
    expect(
      await app.evaluate(
        ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.f12Count'),
        a,
      ),
    ).toBe(0);
    await expect(shell.getByLabel('开发者工具检视列', { exact: true })).toHaveCount(0);
  } finally {
    if (app) {
      await app.close();
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
