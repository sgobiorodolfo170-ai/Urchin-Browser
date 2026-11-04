import { test, expect, _electron as electron } from '@playwright/test';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('middle-button drags sticky anywhere', async () => {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-nb-middrag-'));
  const electronApp = await electron.launch({
    cwd: appPath,
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYWRIGHT: '1',
      URCHIN_TEST_USER_DATA: userDataDir,
      // 数据目录也隔离到临时目录：共享设置库中残留的 notebook.state（上次运行
      // 的笔记/便利贴）会让 [data-sticky].first() 选中错误元素，用例互污
      // （见 workspaces.spec 同款注释）。
      URCHIN_TEST_DATA_DIR: join(userDataDir, 'data'),
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.getByRole('button', { name: '笔记', exact: true }).click();
  await window.getByLabel('便利贴画布').waitFor({ state: 'visible', timeout: 15_000 });

  // 新建便利贴
  await window.getByRole('button', { name: '新建便利贴' }).click();
  const sticky = window.locator('[data-sticky]').first();
  await sticky.waitFor({ state: 'visible' });

  const before = await sticky.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left),
    top: parseFloat((el as HTMLElement).style.top),
  }));

  // 在便利贴正文区域（非标题栏）按中键拖动
  const box = await sticky.boundingBox();
  expect(box).not.toBeNull();
  const targetX = box!.x + box!.width * 0.5;
  const targetY = box!.y + box!.height * 0.7; // 正文区
  await window.mouse.move(targetX, targetY);
  await window.mouse.down({ button: 'middle' });
  await window.mouse.move(targetX + 120, targetY + 80, { steps: 10 });
  await window.mouse.up({ button: 'middle' });

  const after = await sticky.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left),
    top: parseFloat((el as HTMLElement).style.top),
  }));

  expect(after.left).toBeGreaterThan(before.left + 50);
  expect(after.top).toBeGreaterThan(before.top + 30);

  await electronApp.close();
});
