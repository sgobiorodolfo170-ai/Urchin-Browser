import { test as base, _electron, type ElectronApplication } from '@playwright/test';
import { spawn } from 'node:child_process';
import { closeManagedApplication } from './close-electron';
const applications = new Set<ElectronApplication>();
export const electron = {
  launch: async (...args: Parameters<typeof _electron.launch>) => {
    const options = args[0];
    const app = await _electron.launch({
      ...options,
      env: { ...process.env, ...options?.env, URCHIN_NATIVE_EXIT_GUARD: '1' },
    });
    const originalClose = app.close.bind(app);
    const child = app.process();
    let closing: Promise<void> | undefined;
    app.close = () => {
      closing ??= closeManagedApplication(
        { close: originalClose, process: () => child },
        terminate,
      );
      return closing;
    };
    applications.add(app);
    return app;
  },
};
async function terminate(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
    return;
  }
  console.warn(`[e2e] Electron 关闭超时或失败，回收本测试 PID ${pid}`);
  const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      if (code !== 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
      resolve();
    });
    child.once('error', () => resolve());
  });
}
export const test = base.extend<{ managedElectron: void }>({
  managedElectron: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring fixture dependencies.
    async ({}, use) => {
      try {
        await use();
      } finally {
        for (const app of applications) await app.close();
        applications.clear();
      }
    },
    { auto: true, timeout: 15_000 },
  ],
});
