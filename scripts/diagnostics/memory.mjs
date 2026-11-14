/** Isolated, serial memory attribution. Does not change budgets or daily profiles. */
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(process.argv[2] ?? join(here, '../../apps/desktop'));
const output = resolve(process.argv[3] ?? join(tmpdir(), `urchin-memory-${Date.now()}.json`));
const require = createRequire(join(appRoot, 'package.json'));
const { _electron } = require('@playwright/test');
const profile = await mkdtemp(join(tmpdir(), 'urchin-memory-diag-'));
const application = await _electron.launch({
  cwd: appRoot,
  args: ['.', '--js-flags=--expose-gc'],
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PLAYWRIGHT: '1',
    URCHIN_TEST_USER_DATA: profile,
    URCHIN_TEST_DATA_DIR: join(profile, 'data'),
    URCHIN_NATIVE_EXIT_GUARD: '1',
    NODE_OPTIONS: '',
  },
  timeout: 30000,
});
const snapshots = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let main;
async function snapshot(label, native = false) {
  const record = await application.evaluate(({ app, webContents }) => ({
    time: Date.now(),
    metrics: app.getAppMetrics(),
    mainMemory: process.memoryUsage(),
    loadedModules: process.mainModule
      ? Object.keys(process.mainModule.require('node:module')._cache)
      : [],
    webContents: webContents
      .getAllWebContents()
      .map((w) => ({ id: w.id, type: w.getType(), url: w.getURL(), pid: w.getOSProcessId() })),
  }));
  const renderers = [];
  for (const page of application.windows()) {
    try {
      const session = await page.context().newCDPSession(page);
      renderers.push({
        url: page.url(),
        heap: await session.send('Runtime.getHeapUsage'),
        dom: await session.send('Memory.getDOMCounters'),
      });
      await session.detach();
    } catch (error) {
      renderers.push({ url: page.url(), error: String(error) });
    }
  }
  let windowsWorkingSet;
  if (native && process.platform === 'win32') {
    const ids = record.metrics.map((m) => m.pid).join(',');
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(here, 'windows-working-set.ps1'),
        '-ProcessIds',
        ids,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    try {
      windowsWorkingSet = JSON.parse(res.stdout.replace(/^\uFEFF/, ''));
    } catch {
      windowsWorkingSet = { error: res.stderr || res.stdout };
    }
  }
  const item = { label, ...record, renderers, windowsWorkingSet };
  snapshots.push(item);
  await writeFile(output, JSON.stringify({ appRoot, profile, snapshots }, null, 2));
  console.log(
    label,
    JSON.stringify({
      MB: record.metrics.reduce((n, m) => n + m.memory.workingSetSize / 1024, 0),
      mainHeapMB: record.mainMemory.heapUsed / 1024 / 1024,
      processes: record.metrics.length,
    }),
  );
}
let failed = false;
try {
  const deadline = Date.now() + 20000;
  while (!main && Date.now() < deadline) {
    main = application
      .windows()
      .find((p) => p.url().includes('/index.html') && !new URL(p.url()).searchParams.has('view'));
    if (!main) await sleep(50);
  }
  if (!main) throw new Error('main window not found');
  if (!process.argv.includes('--shell-only'))
    await main.locator('[aria-label="左侧边栏"]').waitFor({ state: 'visible' });
  await sleep(3000);
  await snapshot('one-tab', true);
  if (process.argv.includes('--shell-only')) {
    await sleep(5000);
    await snapshot('shell-idle', true);
  } else {
    const windowId = await main.evaluate(
      async () => (await window.urchin.invoke('window.getCurrent', {})).windowId,
    );
    for (let i = 1; i < 10; i++) {
      await main.evaluate(
        async (id) =>
          window.urchin.invoke('tab.create', {
            windowId: id,
            url: 'urchin://newtab',
            active: true,
          }),
        windowId,
      );
      await sleep(200);
    }
    await sleep(3000);
    await snapshot('ten-tabs', true);
    await sleep(5000);
    await snapshot('ten-tabs-idle');
    const result = await main.evaluate(
      async (id) => window.urchin.invoke('tab.list', { windowId: id }),
      windowId,
    );
    for (const tab of result.tabs.slice(1))
      await main.evaluate(async (id) => window.urchin.invoke('tab.close', { tabId: id }), tab.id);
    await sleep(3000);
    await snapshot('closed-back-to-one');
    const repeatArg = process.argv.find((arg) => arg.startsWith('--cycles='));
    const repeats = repeatArg ? Number(repeatArg.slice('--cycles='.length)) : 0;
    if (!Number.isInteger(repeats) || repeats < 0 || repeats > 10)
      throw new Error('--cycles must be an integer between 0 and 10');
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (let i = 1; i < 10; i++)
        await main.evaluate(
          async (id) =>
            window.urchin.invoke('tab.create', {
              windowId: id,
              url: 'urchin://newtab',
              active: true,
            }),
          windowId,
        );
      await sleep(1000);
      const current = await main.evaluate(
        async (id) => window.urchin.invoke('tab.list', { windowId: id }),
        windowId,
      );
      for (const tab of current.tabs.slice(1))
        await main.evaluate(async (id) => window.urchin.invoke('tab.close', { tabId: id }), tab.id);
      await sleep(1000);
      await snapshot('repeat-cycle-' + repeat);
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      await application.evaluate(() => {
        if (typeof global.gc === 'function') global.gc();
      });
      for (const page of application.windows()) {
        try {
          const c = await page.context().newCDPSession(page);
          await c.send('HeapProfiler.collectGarbage');
          await c.detach();
        } catch {}
      }
      await sleep(500);
    }
    await snapshot('after-diagnostic-gc', true);
  }
  if (process.argv.includes('--open-doc')) {
    const filePath = join(profile, 'diagnostic.html');
    await writeFile(filePath, '<!doctype html><h1>Memory diagnostic document</h1>');
    const windowId = await main.evaluate(
      async () => (await window.urchin.invoke('window.getCurrent', {})).windowId,
    );
    const created = await main.evaluate(
      async ({ id, path }) =>
        window.urchin.invoke('tab.create', {
          windowId: id,
          url: 'urchin://genoffice/?kind=html&path=' + encodeURIComponent(path),
          active: true,
        }),
      { id: windowId, path: filePath },
    );
    if (created.tab.viewKind !== 'genoffice')
      throw new Error('GenOffice diagnostic fell back instead of opening the editor');
    await sleep(3000);
    await snapshot('after-first-document', true);
  }
  if (process.argv.includes('--heap-snapshot'))
    await application.evaluate(
      (_, file) => process.mainModule.require('node:v8').writeHeapSnapshot(file),
      output + '.heapsnapshot',
    );
  console.log('Saved', output);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  const child = application.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(5000)]);
  }
}

// Playwright 的一次性驱动连接也可能因被终止的原生进程保持引用；所有报告已 await 写完。
await Promise.race([application.close().catch(() => undefined), sleep(500)]);
process.exit(failed ? 1 : 0);
