/**
 * E2E 测试：pi 网页版启动器（阶段 1 关键路径）
 *
 * 验证「主浏览器 + pi 模块是一个完整项目」的运行方式（2026-08-22 用户决策）：
 * pi 模块由 Urchin 主项目的入口直接启动、以标签页形式在 Urchin 内打开，
 * 随应用退出而终止——而不是在应用外单独 npx 拉起、用其他浏览器查看。
 *
 * 路径：
 * 1. 启动整个 Electron 应用（真实构建产物，不 mock）
 * 2. 左侧栏「AI 助手」入口 → urchin://ai 启动器标签页（dev.39 一键直达：进入即自动启动）
 * 3. 首次运行确认第三方来源说明 → 确认后自动启动（依赖预装、系统 Node 直启、--no-browser）
 * 4. piWeb.status 进入 running；新标签页加载 pi 网页（标题含 pi-web-ui）
 * 5. 服务经 HTTP 探活 200；启动过程不弹系统默认浏览器（--no-browser）
 * 6. 关闭应用 → performCleanup 终止子进程树 → 端口随即不可达（与主项目同生共死）
 *
 * 前置：需已构建 dist/main、dist/preload、dist/renderer（CI/本地先跑 build）+
 * pnpm install（pi-web-ui 依赖预装，运行时零下载）。
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
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 启动 Electron 应用并返回 Playwright 页面（与 launch.spec.ts 相同模式） */
async function launchApp(): Promise<{
  electronApp: ElectronApplication;
  window: Page;
  userDataDir: string;
}> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-piweb-'));

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
  // 捕获渲染进程 console / 未捕获异常：启动链路失败时给出可见线索
  window.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log('[renderer-console-error]', msg.text());
    }
  });
  window.on('pageerror', (err) => {
    console.log('[renderer-pageerror]', err.message);
  });
  // 展开右侧边栏暴露标签列表（折叠态只显示图标条，便于观察新标签出现）
  await window.locator('[aria-label="右侧边栏"]').first().dblclick();
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  return { electronApp, window, userDataDir };
}

/** HTTP 探活：返回状态码（连接失败返回 0） */
async function probe(url: string): Promise<number> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.status;
  } catch {
    return 0;
  }
}

test.describe('pi 网页版启动器（整项目运行路径）', () => {
  test('从主项目入口启动 pi 模块并在 Urchin 标签页内打开，随应用退出终止', async () => {
    test.setTimeout(180_000);
    const { electronApp, window, userDataDir } = await launchApp();

    // 1. 左侧栏「AI 助手」→ urchin://ai 启动器标签页（dev.39 一键直达：进入即自动启动）
    await window.getByRole('button', { name: 'AI 助手' }).click();

    // 2. 首次运行需确认第三方来源说明（确认后立即自动启动）。
    //    注意：确认标记存于主窗口 localStorage，而 DD1 布局下 sessionData 分区
    //    （<软件根>/data/cookies）不随测试临时 userData 变化——说明可能已被
    //    此前运行确认过而不再弹出，两条路径都要兼容。
    const ackBtn = window.getByRole('button', { name: /我已知晓/ });
    try {
      await ackBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await ackBtn.click();
    } catch {
      // 已确认过：autoStart 直接生效，无需确认
    }

    // 3. 轮询 piWeb.status（渲染层真实 preload→IPC 链路）直到 running，取得入口 URL。
    //    注意：就绪后 pi 标签被创建并激活，启动器视图随之卸载——「运行中」文本不可作为等待目标；
    //    逐次 evaluate 而非 waitForFunction（标签切换可能销毁前一个执行上下文的句柄）。
    interface StatusSnapshot {
      state?: string;
      url?: string;
      lastError?: string;
    }
    let url: string | null = null;
    let lastStatus: StatusSnapshot | null = null;
    const statusDeadline = Date.now() + 150_000;
    while (Date.now() < statusDeadline) {
      lastStatus = await window.evaluate(async (): Promise<StatusSnapshot | null> => {
        const w = window as unknown as {
          urchin?: { invoke: (c: string, r: unknown) => Promise<StatusSnapshot> };
        };
        if (!w.urchin) return null;
        try {
          return await w.urchin.invoke('piWeb.status', {});
        } catch {
          return null;
        }
      });
      if (lastStatus?.state === 'running' && typeof lastStatus.url === 'string') {
        url = lastStatus.url;
        break;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!url) {
      throw new Error(
        `piWeb.status 未在 150s 内进入 running，最后状态: ${JSON.stringify(lastStatus)}`,
      );
    }
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);

    // 4. pi 网页以标签页在 Urchin 内打开：侧栏出现该标签（折叠态为按钮 aria-label，
    //    展开态为卡片标题，两种布局任一命中即可）
    const piTab = window
      .getByRole('button', { name: /pi-web-ui/i })
      .or(window.getByText(/pi-web-ui/i).first());
    await expect(piTab.first()).toBeVisible({ timeout: 30_000 });

    // 5. 测试进程 HTTP 探活（服务真实可访问）
    expect(await probe(url)).toBe(200);

    // 5.5 dev.43：启动链路已向临时 profile 预置 auth.json 空白占位
    //     （isPiConfigured 判定通过 → 「下载 pi agent」引导被抑制）
    const seededAuth = readFileSync(join(userDataDir, 'pi', 'agent', 'auth.json'), 'utf-8');
    expect(seededAuth).toContain('_urchin_bootstrap');

    // 6. 关闭应用 → 子进程树随 performCleanup 终止 → 端口不可达（与主项目同生共死）
    await electronApp.close();
    let down = false;
    for (let i = 0; i < 10; i++) {
      if ((await probe(url)) === 0) {
        down = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(down).toBe(true);
  });
});
