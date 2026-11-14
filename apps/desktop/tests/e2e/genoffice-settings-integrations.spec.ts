import { test, electron } from './helpers/electron-test';
/**
 * E2E：GenOffice 设置「集成/技能」页中性桩（window.aiOfficeIntegrations 桥）
 *
 * 背景：上游 IntegrationsPane / FoundSkills 读独立全局 window.aiOfficeIntegrations
 * （IntegrationsPane.tsx:55 / FoundSkills.tsx:13），此前宿主 preload 漏暴露该全局
 * （桩误挂在 window.aiOffice.integrations 下成为死代码），两页永远卡在
 * 「正在检测…」加载态——用户看到的空白页。
 *
 * 覆盖路径：
 * 1. shell Home → 设置弹窗 →「集成」页：hero 引导区 + MCP 服务区块渲染
 *    （hero 只在 status() 返回后渲染；加载态只有标题+一行文案——桥修复的核心回归信号）
 * 2. 「技能」页：「我的技能」空态渲染（加载态 FoundSkills 整页 return null）
 *
 * 前置：`pnpm genoffice:build`（vendor 产物）；缺失时整组 skip，保证 CI 无 vendor
 * 构建时流水线不误红（打包/本地验收跑完整路径）。
 */
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** vendor 嵌入产物（与 genoffice-markdown.spec.ts 同一门禁） */
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

async function launchApp(): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-genoffice-intg-'));

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
  return { electronApp, window };
}

/** 侧栏入口打开 shell Home 视图并等待 `.home` 根节点渲染（同 genoffice-markdown.spec.ts）。 */
async function openShellHome(electronApp: ElectronApplication, window: Page): Promise<void> {
  await window.getByLabel('GenOffice 文档').click();
  await expect
    .poll(async () => execShell<boolean>(electronApp, `!!document.querySelector('.home')`), {
      timeout: 60_000,
    })
    .toBe(true);
}

/** 在 shell 页 webContents 内执行脚本（真实 preload/协议链路）。 */
async function execShell<T>(
  electronApp: ElectronApplication,
  script: string,
): Promise<T | undefined> {
  return electronApp.evaluate(async ({ webContents }, code) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => w.getURL().startsWith('genoffice-app://shell/'));
    return (await wc?.executeJavaScript(code)) as T | undefined;
  }, script);
}

/** 打开设置弹窗并点击左侧导航项（双语匹配，不假设宿主 locale）。 */
async function openSettingsSection(
  electronApp: ElectronApplication,
  sectionPattern: RegExp,
): Promise<void> {
  const opened = await execShell<boolean>(
    electronApp,
    `(() => {
      const entry = document.querySelector('.account-entry');
      const btn = entry?.querySelector('button');
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
  );
  expect(opened).toBe(true);
  await expect
    .poll(async () => execShell<boolean>(electronApp, `!!document.querySelector('.set-dialog')`), {
      timeout: 15_000,
    })
    .toBe(true);
  const pattern = sectionPattern.source;
  const clicked = await execShell<boolean>(
    electronApp,
    `(() => {
      const item = [...document.querySelectorAll('.set-nav-item')].find((b) =>
        new RegExp(${JSON.stringify(pattern)}, 'i').test(b.textContent || ''),
      );
      if (!item) return false;
      item.click();
      return true;
    })()`,
  );
  expect(clicked).toBe(true);
}

test.skip(!existsSync(GENOFFICE_EMBED), 'vendor GenOffice 产物缺失：先执行 pnpm genoffice:build');

test('设置「集成」页渲染完整中性桩内容（不再卡加载态）', async () => {
  test.setTimeout(120_000);
  const { electronApp, window } = await launchApp();
  await openShellHome(electronApp, window);
  await openSettingsSection(electronApp, /集成|Integrations/i);

  // 核心回归断言：hero 引导区只在 status() 返回后渲染。桥缺失时面板永远停在
  // 加载态（只有标题 + 「正在检测…」一行文案），hero/MCP 区块均不出现 → 空白页。
  // 中性桩下 agents=[] → 「没有列出我的助手」折叠区默认展开；MCP 区块显示已停止开关。
  await expect
    .poll(
      async () =>
        execShell<Record<string, boolean>>(
          electronApp,
          `({
            hero: !!document.querySelector('.set-intg-hero'),
            mcp: !!document.querySelector('.set-mcp-server'),
            loading: /正在检测|Detecting/i.test(document.body.innerText || ''),
          })`,
        ),
      { timeout: 15_000 },
    )
    .toEqual({ hero: true, mcp: true, loading: false });

  await electronApp.close();
});

test('设置「技能」页渲染「我的技能」空态（此前整页空白）', async () => {
  test.setTimeout(120_000);
  const { electronApp, window } = await launchApp();
  await openShellHome(electronApp, window);
  await openSettingsSection(electronApp, /技能|Skills/i);

  // 加载态 FoundSkills return null（连标题都没有）；桥修复后 listSkills() 返回
  // 空数组 → 渲染标题 + 空态文案（intgSkillsEmpty）
  await expect
    .poll(
      async () =>
        execShell<Record<string, boolean>>(
          electronApp,
          `({
            title: /技能|Skills/i.test(
              document.querySelector('.set-pane-title')?.textContent || '',
            ),
            empty: /还没有安装技能|No skills installed yet/i.test(document.body.innerText || ''),
          })`,
        ),
      { timeout: 15_000 },
    )
    .toEqual({ title: true, empty: true });

  await electronApp.close();
});
