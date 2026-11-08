import { test, expect, _electron as electron } from '@playwright/test';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('notebook regions fill', async () => {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-nb-regions-'));
  const electronApp = await electron.launch({
    cwd: appPath,
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYWRIGHT: '1',
      URCHIN_TEST_USER_DATA: userDataDir,
      URCHIN_TEST_DATA_DIR: join(userDataDir, 'data'),
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.getByRole('button', { name: '笔记', exact: true }).click();
  await window.getByLabel('笔记导航').waitFor({ state: 'visible', timeout: 15_000 });
  await window.waitForTimeout(1500);

  const dims = await window.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('[aria-label="笔记导航"]');
    const content = document.querySelector<HTMLElement>('[aria-label="笔记内容"]');
    const canvas = document.querySelector<HTMLElement>('[aria-label="便利贴画布"]');
    const grid = document.querySelector<HTMLElement>('[data-notebook-page]');
    return {
      grid: grid
        ? { w: grid.offsetWidth, h: grid.offsetHeight, cols: grid.style.gridTemplateColumns }
        : null,
      nav: nav ? { w: nav.offsetWidth, h: nav.offsetHeight } : null,
      content: content ? { w: content.offsetWidth, h: content.offsetHeight } : null,
      canvas: canvas
        ? { w: canvas.offsetWidth, h: canvas.offsetHeight, r: canvas.getBoundingClientRect() }
        : null,
    };
  });
  console.log('REGIONS', JSON.stringify(dims));
  expect(dims.grid).not.toBeNull();
  await electronApp.close();
});
