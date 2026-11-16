import { test, electron } from './helpers/electron-test';
import { expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForShellReady } from './helpers/status-bar';
test('mail login renders configurable OAuth providers and preserves password providers', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-mail-oauth-'));
  const app = await electron.launch({
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYWRIGHT: '1',
      URCHIN_TEST_USER_DATA: userDataDir,
      URCHIN_TEST_DATA_DIR: join(userDataDir, 'data'),
      NODE_OPTIONS: '',
    },
    timeout: 30000,
  });
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await waitForShellReady(window);
    await window.getByRole('button', { name: '邮箱', exact: true }).click();
    await expect(window.getByRole('heading', { name: '登录邮箱', exact: true })).toBeVisible();
    await window.getByRole('button', { name: /Outlook \/ Hotmail/ }).click();
    await expect(window.getByLabel('OAuth Client ID')).toHaveValue('');
    await expect(window.getByLabel('密码', { exact: true })).toHaveCount(0);
    await expect(window.getByRole('button', { name: '使用 Microsoft 授权登录' })).toBeDisabled();
    await window.getByLabel('邮箱地址').fill('me@hotmail.com');
    await window.getByLabel('OAuth Client ID').fill('test-client');
    await expect(window.getByRole('button', { name: '使用 Microsoft 授权登录' })).toBeEnabled();
    await window.getByRole('button', { name: /Gmail/ }).click();
    await expect(window.getByLabel('Google 桌面应用 Client Secret')).toBeVisible();
    await expect(window.getByLabel('授权码 / 应用专用密码')).toBeVisible();
    await window.getByRole('button', { name: '返回邮箱主页' }).click();
    await expect(window.getByText('请登录', { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});
