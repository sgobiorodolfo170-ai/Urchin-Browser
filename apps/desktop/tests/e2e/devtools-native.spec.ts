/** ADR-022 P0-B：通过真实键盘输入通路验证原生工具，不调用内部 toggle。 */
import { test, electron } from './helpers/electron-test';
import { expect, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
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
    // Electron's detached native delegate does not route before-input-event.
    // Exercise its actual DOM keyboard adapter here; OS F12 is independently
    // verified through Windows system input (see the acceptance evidence).
    await app
      .evaluate(async ({ webContents }, wcId) => {
        const result: unknown = await webContents.fromId(wcId)!.executeJavaScript(`(() => {
        const down = new KeyboardEvent('keydown', { key: 'F12', code: 'F12', bubbles: true, cancelable: true });
        dispatchEvent(down);
        return down.defaultPrevented;
      })()`);
        return result;
      }, id)
      .then((consumed) => expect(consumed).toBe(true));
    return;
  }
  await app.evaluate(({ app, BrowserWindow, webContents }, wcId) => {
    // Windows 前台锁会拒绝普通 focus（前一实例被 taskkill 后尤其明显）；
    // steal 是 Electron 为“必须拿到前台”的测试/自动化场景提供的显式通道。
    app.focus({ steal: true });
    const wc = webContents.fromId(wcId);
    const win = wc ? BrowserWindow.fromWebContents(wc) : null;
    win?.show();
    win?.focus();
    wc?.focus();
  }, id);
  const focusDeadline = Date.now() + 10_000;
  let focused = false;
  while (Date.now() < focusDeadline) {
    focused = await app.evaluate(
      ({ webContents }, wcId) => webContents.fromId(wcId)?.isFocused() ?? false,
      id,
    );
    if (focused) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!focused) {
    const diagnostic = await app.evaluate(
      ({ BrowserWindow, webContents }, wcId) => ({
        target: wcId,
        focusedWindow: BrowserWindow.getFocusedWindow()?.webContents.id ?? null,
        windows: BrowserWindow.getAllWindows().map((win) => ({
          id: win.webContents.id,
          focused: win.isFocused(),
          visible: win.isVisible(),
          minimized: win.isMinimized(),
        })),
        targetExists: Boolean(webContents.fromId(wcId)),
      }),
      id,
    );
    throw new Error(`focus timeout: ${JSON.stringify(diagnostic)}`);
  }
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

async function diagnostics(app: ElectronApplication) {
  return app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule('module')
      .createRequire(app.getAppPath() + '/package.json');
    const main: unknown = load('./dist/main/index.js');
    return (
      main as {
        getNativeDevtoolsDiagnostics(): {
          sessions: number;
          tabInputs: number;
          windowInputs: number;
          extraInputs: number;
          timers: number;
        };
      }
    ).getNativeDevtoolsDiagnostics();
  });
}

async function resources(app: ElectronApplication, target: number) {
  const counts = await diagnostics(app);
  const runtime = await app.evaluate(({ app, webContents }, id) => {
    const wc = webContents.fromId(id)!;
    return {
      listeners: Object.fromEntries(
        [
          'before-input-event',
          'devtools-opened',
          'devtools-closed',
          'destroyed',
          'render-process-gone',
        ].map((name) => [name, wc.listenerCount(name)]),
      ),
      memoryMB: app
        .getAppMetrics()
        .reduce((sum, item) => sum + item.memory.workingSetSize / 1024, 0),
      processes: app
        .getAppMetrics()
        .map((m) => ({ type: m.type, pid: m.pid, memoryMB: m.memory.workingSetSize / 1024 })),
      toolCount: webContents.getAllWebContents().filter((w) => w.getURL().startsWith('devtools://'))
        .length,
    };
  }, target);
  return { counts, ...runtime };
}

// eslint-disable-next-line no-empty-pattern -- Only testInfo is needed; no browser page fixture.
test('native F12: shell/page/tool, fixed targets, manual close and 20 cycles', async ({}, testInfo) => {
  test.setTimeout(180_000);
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
    // Discard startup Internet pages so the memory fixture has only controlled tabs.
    const startup = (await shell.evaluate(
      (windowId) => window.urchin.invoke('tab.list', { windowId }),
      current.windowId,
    )) as { tabs: { id: number }[] };
    for (const tab of startup.tabs) {
      if (tab.id !== created.tab.id)
        await shell.evaluate((tabId) => window.urchin.invoke('tab.close', { tabId }), tab.id);
    }
    await input(app, shellId);
    await expect.poll(() => state(app!, a).then((s) => s.open)).toBe(true);
    expect((await state(app, a)).attached).toBe(false);
    const toolA = await toolId(app, a);
    // 原生 UI 实际加载并显示多个面板，不以 opened=true 单独判成功。
    await expect
      .poll(() =>
        app!.evaluate(async ({ webContents }, id) => {
          const labels: unknown = await webContents.fromId(id)!.executeJavaScript(`(() => {
      const labels=[]; const visit=root=>{for(const el of root.querySelectorAll('*')){if(el.getAttribute('role')==='tab')labels.push(el.id);if(el.shadowRoot)visit(el.shadowRoot)}}; visit(document); return labels.join('|');
    })()`);
          return typeof labels === 'string' ? labels : '';
        }, toolA),
      )
      .toContain('tab-console');
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
    await expect.poll(() => state(app!, a)).toEqual({ open: false, toolId: null, attached: false });
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
    await expect.poll(() => state(app!, a)).toEqual({ open: false, toolId: null, attached: false });
    // Ownership A/B is already verified. The resource budget now measures one target,
    // rather than retaining an unrelated second tab and its renderer throughout.
    const remaining = (await shell.evaluate(
      (windowId) => window.urchin.invoke('tab.list', { windowId }),
      current.windowId,
    )) as { tabs: { id: number }[] };
    for (const tab of remaining.tabs) {
      if (tab.id !== created.tab.id)
        await shell.evaluate((tabId) => window.urchin.invoke('tab.close', { tabId }), tab.id);
    }
    await expect.poll(() => diagnostics(app!).then((d) => d.tabInputs)).toBe(1);
    const baseline = await resources(app, a);
    const samples: number[] = [];
    // Four warm-up cycles allow Chromium frontend caches to settle; measure the next 20.
    for (let i = 0; i < 24; i++) {
      await input(app, a);
      await expect.poll(() => state(app!, a).then((s) => s.open)).toBe(true);
      const tool = await toolId(app, a);
      await input(app, tool, true);
      await expect
        .poll(() => state(app!, a))
        .toEqual({ open: false, toolId: null, attached: false });
      await expect.poll(() => diagnostics(app!)).toEqual(baseline.counts);
      const current = await resources(app, a);
      expect(current.listeners).toEqual(baseline.listeners);
      expect(current.toolCount).toBe(baseline.toolCount);
      if (i >= 4) {
        // Sampling interval, not a substitute for a readiness assertion.
        await new Promise((r) => setTimeout(r, 250));
        samples.push((await resources(app, a)).memoryMB);
      }
    }
    const n = samples.length;
    const mean = samples.reduce((a, b) => a + b, 0) / n;
    const mid = (n - 1) / 2;
    const xx = samples.reduce((sum, _, i) => sum + (i - mid) ** 2, 0);
    const xy = samples.reduce((sum, y, i) => sum + (i - mid) * (y - mean), 0);
    const yy = samples.reduce((sum, y) => sum + (y - mean) ** 2, 0);
    const slopeMBPerCycle = xy / xx;
    const rSquared = yy ? xy ** 2 / (xx * yy) : 0;
    const budgetMB = Number(process.env.URCHIN_PERF_BUDGET_MB ?? (process.env.CI ? 750 : 800));
    const versions = await app.evaluate(() => ({
      platform: process.platform,
      os: process.getSystemVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
    }));
    // ADR-019 requires three settled samples and their minimum, rather than
    // treating a transient working-set peak as a new absolute gate.
    await new Promise((r) => setTimeout(r, 3000));
    const settledSamplesMB: number[] = [];
    for (let i = 0; i < 3; i++) {
      settledSamplesMB.push((await resources(app, a)).memoryMB);
      if (i < 2) await new Promise((r) => setTimeout(r, 2000));
    }
    const regressionMemoryMB = Math.min(...settledSamplesMB);
    const evidence = {
      versions,
      settledSamplesMB,
      regressionMemoryMB,
      baseline,
      final: await resources(app, a),
      samplesMB: samples,
      slopeMBPerCycle,
      rSquared,
      budgetMB,
    };
    writeFileSync(
      testInfo.outputPath('devtools-resources.json'),
      JSON.stringify(evidence, null, 2),
    );
    console.log('DevTools resource evidence', JSON.stringify(evidence));
    expect(regressionMemoryMB).toBeLessThanOrEqual(budgetMB);
    // A sustained trend means >=1 MB/cycle with R²>=0.8 after warm-up.
    expect(slopeMBPerCycle >= 1 && rSquared >= 0.8, 'sustained linear growth after warm-up').toBe(
      false,
    );
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

test('native ownership, workspaces, navigation, unsupported targets and teardown', async () => {
  test.setTimeout(180_000);
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>ownership fixture</title><h1>Owned page</h1><script>window.probe=42</script>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server unavailable');
  const base = `http://127.0.0.1:${address.port}`;
  const profile = mkdtempSync(join(tmpdir(), 'urchin-native-matrix-'));
  const app = await electron.launch({
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
  try {
    const shell = await app.firstWindow();
    await shell.waitForLoadState('domcontentloaded');
    const first = (await shell.evaluate(() => window.urchin.invoke('window.getCurrent', {}))) as {
      windowId: number;
    };
    const create = async (windowId: number, url: string, workspaceId?: string) => {
      const result = (await shell.evaluate((args) => window.urchin.invoke('tab.create', args), {
        windowId,
        url,
        active: true,
        workspaceId,
      })) as { tab: { id: number; workspaceId: string } };
      let id = 0;
      await expect
        .poll(async () => {
          const value = await app.evaluate(
            ({ webContents }, url) =>
              webContents.getAllWebContents().find((w) => w.getURL() === url && !w.isLoading())?.id,
            url,
          );
          id = value ?? 0;
          return id > 0;
        })
        .toBe(true);
      return { ...result.tab, wc: id };
    };
    const a = await create(first.windowId, base + '/a');
    const isolation: unknown = await app.evaluate(
      ({ webContents }, id) =>
        webContents
          .fromId(id)!
          .executeJavaScript(
            '({bridge:typeof window.urchin,node:typeof require,ipc:typeof ipcRenderer})',
          ) as Promise<unknown>,
      a.wc,
    );
    expect(isolation).toEqual({ bridge: 'undefined', node: 'undefined', ipc: 'undefined' });
    const workspace = (await shell.evaluate(() =>
      window.urchin.invoke('workspace.create', { name: 'Native acceptance', color: 'cyan' }),
    )) as { workspace: { id: string } };
    const b = await create(first.windowId, base + '/b', workspace.workspace.id);
    await input(app, b.wc);
    const bTool = await toolId(app, b.wc);
    await shell.evaluate((tabId) => window.urchin.invoke('tab.setActive', { tabId }), a.id);
    await input(app, a.wc);
    const aTool = await toolId(app, a.wc);
    const clipped = (await shell.evaluate(
      (tabId) => window.urchin.invoke('clipper.page', { tabId }),
      a.id,
    )) as { html: string };
    expect(clipped.html).toContain('Owned page');
    expect((await state(app, a.wc)).toolId).toBe(aTool);
    expect((await state(app, a.wc)).attached).toBe(false);

    expect((await state(app, b.wc)).toolId).toBe(bTool);
    // Closing B returns to its bound page/workspace, without retargeting A.
    await input(app, bTool, true);
    await expect.poll(() => state(app, b.wc).then((s) => s.open)).toBe(false);
    const active = (await shell.evaluate(
      (windowId) => window.urchin.invoke('tab.list', { windowId }),
      first.windowId,
    )) as { tabs: { id: number; active: boolean }[] };
    expect(active.tabs.find((t) => t.active)?.id).toBe(b.id);
    await expect
      .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id))
      .toBe(b.wc);
    await shell.evaluate((tabId) => window.urchin.invoke('tab.setActive', { tabId }), a.id);
    expect((await state(app, a.wc)).toolId).toBe(aTool);
    // Same webContents across reload, bypass-cache reload and same-tab navigation.
    await shell.evaluate(
      (tabId) => window.urchin.invoke('tab.reload', { tabId, ignoreCache: true }),
      a.id,
    );
    await expect
      .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), a.wc))
      .toBe(false);
    expect((await state(app, a.wc)).toolId).toBe(aTool);
    await shell.evaluate((args) => window.urchin.invoke('tab.loadUrl', args), {
      tabId: a.id,
      url: base + '/navigated',
    });
    await expect
      .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), a.wc))
      .toBe(base + '/navigated');
    expect((await state(app, a.wc)).toolId).toBe(aTool);
    const second = (await shell.evaluate(() => window.urchin.invoke('window.create', {}))) as {
      windowId: number;
    };
    const c = await create(second.windowId, base + '/c', workspace.workspace.id);
    await input(app, c.wc);
    const cTool = await toolId(app, c.wc);
    expect(cTool).not.toBe(aTool);
    await shell.evaluate((args) => window.urchin.invoke('window.close', args), {
      windowId: second.windowId,
    });
    await expect
      .poll(() => app.evaluate(({ webContents }, id) => !!webContents.fromId(id), c.wc))
      .toBe(false);
    await expect
      .poll(() => app.evaluate(({ webContents }, id) => !!webContents.fromId(id), cTool))
      .toBe(false);
    expect((await state(app, a.wc)).open).toBe(true);
    // A crashed target disposes its tool and can be reloaded and reopened.
    await app.evaluate(
      ({ webContents }, id) => webContents.fromId(id)!.forcefullyCrashRenderer(),
      a.wc,
    );
    await expect.poll(() => state(app, a.wc).then((s) => s.open)).toBe(false);
    await expect.poll(() => diagnostics(app).then((s) => s.sessions)).toBe(0);
    await shell.evaluate((tabId) => window.urchin.invoke('tab.reload', { tabId }), a.id);
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }, id) =>
            webContents.fromId(id)!.isCrashed() || webContents.fromId(id)!.isLoading(),
          a.wc,
        ),
      )
      .toBe(false);
    await input(app, a.wc);
    await toolId(app, a.wc);
    await shell.evaluate((tabId) => window.urchin.invoke('tab.close', { tabId }), a.id);
    await expect
      .poll(() => app.evaluate(({ webContents }, id) => !!webContents.fromId(id), a.wc))
      .toBe(false);
    await expect.poll(() => diagnostics(app).then((s) => s.sessions)).toBe(0);
    // Intercept only the blocking native dialog, retaining its exact user-facing reason.
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { dtMessages: string[]; dtOriginal: unknown };
      g.dtMessages = [];
      g.dtOriginal = dialog.showMessageBox;
      dialog.showMessageBox = (...args: unknown[]) => {
        const opts = args.at(-1) as { message: string };
        g.dtMessages.push(opts.message);
        return Promise.resolve({ response: 0, checkboxChecked: false });
      };
    });
    const internal = (await shell.evaluate(
      (windowId) =>
        window.urchin.invoke('tab.create', { windowId, url: 'urchin://settings', active: true }),
      first.windowId,
    )) as { tab: { id: number } };
    const shellId = (await shell.evaluate(() => window.urchin.invoke('window.getCurrent', {}))) as {
      windowId: number;
    };
    expect(shellId.windowId).toBe(first.windowId);
    const shellWc = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().endsWith('/renderer/index.html'),
        )!.webContents.id,
    );
    await input(app, shellWc);
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { dtMessages: string[] }).dtMessages.length),
      )
      .toBe(1);
    expect(
      await app.evaluate(() => (globalThis as unknown as { dtMessages: string[] }).dtMessages[0]),
    ).toContain('内部页面和 GenOffice');
    expect((await diagnostics(app)).sessions).toBe(0);
    expect((await state(app, shellWc)).open).toBe(false);
    await shell.evaluate((tabId) => window.urchin.invoke('tab.close', { tabId }), internal.tab.id);
    const editorPath = join(profile, 'unsupported-editor.html');
    writeFileSync(editorPath, '<!doctype html><h1>GenOffice unsupported fixture</h1>');
    const editor = (await shell.evaluate((args) => window.urchin.invoke('tab.create', args), {
      windowId: first.windowId,
      url: 'urchin://genoffice/?kind=html&path=' + encodeURIComponent(editorPath),
      active: true,
    })) as { tab: { id: number; viewKind: string } };
    expect(editor.tab.viewKind).toBe('genoffice');
    await input(app, shellWc);
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { dtMessages: string[] }).dtMessages.length),
      )
      .toBe(2);
    expect((await diagnostics(app)).sessions).toBe(0);
    expect((await state(app, shellWc)).open).toBe(false);
    await shell.evaluate((tabId) => window.urchin.invoke('tab.close', { tabId }), editor.tab.id);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (
        globalThis as unknown as { dtOriginal: typeof dialog.showMessageBox }
      ).dtOriginal;
    });
    const nativeErrors = () =>
      readdirSync(join(profile, 'data', 'data', 'logs'))
        .filter((name) => name.endsWith('.log'))
        .flatMap((name) =>
          readFileSync(join(profile, 'data', 'data', 'logs', name), 'utf8').split('\n'),
        )
        .filter((line) => line.includes('"module":"native-devtools"'))
        .map((line) => JSON.parse(line) as { meta: Record<string, unknown> });
    await expect.poll(() => nativeErrors().length).toBeGreaterThanOrEqual(2);
    for (const entry of nativeErrors()) {
      expect(Object.keys(entry.meta).sort()).toEqual(['stage', 'tabId', 'windowId']);
      expect(entry.meta.stage).toBe('target');
    }
    // Quit with a live native tool, then prove every process owned by this app exited.
    const exitTarget = await create(first.windowId, base + '/exit');
    await input(app, exitTarget.wc);
    await toolId(app, exitTarget.wc);
    const pids = await app.evaluate(({ app }) => app.getAppMetrics().map((item) => item.pid));
    const child = app.process();
    const closed = app.waitForEvent('close', { timeout: 15_000 });
    await app.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 0);
    });
    await closed;
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expect
      .poll(
        () =>
          pids.filter((pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code !== 'ESRCH';
            }
          }),
        { timeout: 15_000 },
      )
      .toEqual([]);
  } finally {
    await app.close();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});
