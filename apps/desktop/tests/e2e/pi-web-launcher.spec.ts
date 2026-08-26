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

    // 5.6 dev.44：目录选择器注入脚本已就位；直调 __ubCwdPickerPick 走
    //     与原生选择器相同的「填路径 + Enter」链路（原生弹窗为 OS 标准件，
    //     E2E 不弹窗，用调试入口替代;目标目录 G: 仓库根真实存在）
    //     dev.47 补盲区：先验证「真实点击 → 捕获拦截 → fetch 协议端点」链路——
    //     覆写页面 fetch 截获请求（不真发，避免弹原生对话框），断言点击不弹
    //     pi 原生手输入框、且 fetch 目标为 urchin://pi-pick-dir。
    interface PickResult {
      installed?: boolean;
      clickIntercepted?: boolean;
      fetchedEndpoint?: boolean;
      inputOpened?: boolean;
      switched?: boolean;
      error?: string;
    }
    const pickResult = await electronApp.evaluate(
      async ({ webContents }, piUrl): Promise<PickResult> => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(piUrl));
        if (!wc) return { error: 'pi webContents not found' };
        // 注入脚本幂等标志存在 = 拦截已生效
        const installed = (await wc.executeJavaScript(
          '!!window.__ubCwdPickerInstalled',
        )) as boolean;
        if (!installed) return { installed, error: 'picker script not injected' };

        // 真实点击链路：覆写 fetch 截获（不真发），点击按钮后检查拦截效果
        await wc.executeJavaScript(`(() => {
          window.__ubFetchLog = [];
          const orig = window.fetch.bind(window);
          window.__ubFetchOrigRestore = () => { window.fetch = orig; };
          window.fetch = function (input) {
            window.__ubFetchLog.push(String(input));
            if (String(input).includes('pi-pick-dir')) {
              return Promise.resolve(new Response(JSON.stringify({ path: null }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }));
            }
            return orig(input);
          };
        })()`);
        await wc.executeJavaScript(`(() => {
          const btn = document.querySelector('button.status-cwd');
          if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        })()`);
        await new Promise((r) => setTimeout(r, 1000));
        const clickCheck = (await wc.executeJavaScript(`(() => ({
          fetchLog: window.__ubFetchLog,
          inputOpened: !!document.querySelector('input.status-cwd-input'),
        }))()`)) as { fetchLog: string[]; inputOpened: boolean };
        // 还原 fetch，避免影响后续链路
        await wc.executeJavaScript(`window.__ubFetchOrigRestore && window.__ubFetchOrigRestore()`);

        await wc.executeJavaScript(
          `window.__ubCwdPickerPick('G:/pj/pj--ing/111111/Urchin-Browser')`,
        );
        await new Promise((r) => setTimeout(r, 3000));
        const cwdText = (await wc.executeJavaScript(
          `document.querySelector('button.status-cwd, .status-cwd-wrap')?.textContent ?? ''`,
        )) as string;
        return {
          installed,
          clickIntercepted: !clickCheck.inputOpened,
          fetchedEndpoint: clickCheck.fetchLog.some((u) => u.includes('urchin://pi-pick-dir')),
          inputOpened: clickCheck.inputOpened,
          switched: cwdText.includes('Urchin-Browser') && cwdText.includes('G:'),
        };
      },
      url,
    );
    // dev.47：真实点击链路三重断言——拦截(不弹手输框) + fetch 命中协议端点 + 切换成功
    expect(pickResult).toMatchObject({
      installed: true,
      clickIntercepted: true,
      fetchedEndpoint: true,
      switched: true,
    });

    // 5.7 dev.45：页面增强——主题默认亮色 / 最近项目删除按钮 / 路径提示抑制。
    //     主题脚本在页面加载即执行（含一次 reload 兜底），轮询等待其稳定。
    interface EnhanceResult {
      theme?: string | null;
      projectItems?: number;
      delButtons?: number;
      hiddenAfterDel?: boolean;
      confirmAsked?: boolean;
      noticeSuppressed?: boolean;
      updateCssReady?: boolean;
      newChatMoved?: boolean;
      themeSelectorHidden?: boolean;
      pinnedTabIcon?: string | null;
      error?: string;
    }
    // dev.48 前置：开「链接在新标签页打开」，使 pi 页 window.open 产生新标签
    //（图标钉定断言依赖新标签创建路径）
    await window.evaluate(async () => {
      const w = window as unknown as {
        urchin: { invoke: (c: string, r: unknown) => Promise<unknown> };
      };
      await w.urchin.invoke('settings.set', { key: 'links.openInNewTab', value: true });
    });
    const enhance = await electronApp.evaluate(
      async ({ webContents }, piUrl): Promise<EnhanceResult> => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(piUrl));
        if (!wc) return { error: 'pi webContents not found' };
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

        // 主题跟随浏览器（dev.48）：E2E 环境浏览器为亮色 → pi 应跟进 light
        let theme: string | null = null;
        for (let i = 0; i < 16; i++) {
          theme = (await wc.executeJavaScript(`localStorage.getItem('pi-web-ui:theme')`)) as
            string | null;
          if (theme === 'light') break;
          await wait(500);
        }

        // dev.48：新对话移植——顶栏原按钮隐藏 + 历史对话标题行有注入按钮
        await wait(600);
        const newChat = (await wc.executeJavaScript(`(() => {
          const orig = document.querySelector('button.chip.newchat');
          const injected = document.querySelector(
            '.panel-sessions > .panel-section-title .__ubNewChat',
          );
          // 右对齐用几何断言：注入按钮右缘贴近标题行右缘
          //（margin-left:auto 的 computed 值会被解析为像素，不能直接比对）
          let rightAligned = false;
          if (injected) {
            const row = injected.closest('.panel-section-title');
            if (row) {
              const r = injected.getBoundingClientRect();
              const rr = row.getBoundingClientRect();
              rightAligned = rr.right - r.right < 40;
            }
          }
          return {
            origHidden: orig ? getComputedStyle(orig).display === 'none' : false,
            injected: !!injected,
            rightAligned,
          };
        })()`)) as { origHidden: boolean; injected: boolean; rightAligned: boolean };

        // dev.49：主题切换按钮被删除（顶栏无「主题」触发器——chip 不存在或其
        // .dropdown 包装已从 DOM 移除；替代 dev.48 的隐藏类方案）
        const themeSel = (await wc.executeJavaScript(`(() => {
          const chips = Array.from(document.querySelectorAll('span.chip-sub'));
          const themeChip = chips.find((c) => /^(主题|theme)$/i.test((c.textContent || '').trim()));
          if (!themeChip) return { present: false, hidden: true, removed: true };
          const dd = themeChip.closest('.dropdown');
          return {
            present: true,
            hidden: !!dd && getComputedStyle(dd).display === 'none',
            removed: !!dd && !document.body.contains(dd),
          };
        })()`)) as { present: boolean; hidden: boolean; removed: boolean };

        // 5.6 已切换到 G:/ 仓库 → 最近项目应有该条目且带删除按钮
        await wait(1000);
        const counts = (await wc.executeJavaScript(`(() => {
          const items = document.querySelectorAll('button.project-item');
          return { items: items.length, dels: document.querySelectorAll('.__ubProjDel').length };
        })()`)) as { items: number; dels: number };

        // 点击 G:/ 条目的删除按钮 → 行隐藏（dev.47：删除需先过确认——
        // 设 __ubProjDelConfirm 钩子自动确认，避免真弹原生确认框阻塞测试）
        let hiddenAfterDel = false;
        let confirmAsked = false;
        if (counts.items > 0) {
          const delResult = (await wc.executeJavaScript(`(() => {
            window.__ubProjDelConfirm = function () { window.__ubDelAsked = true; return true; };
            const rows = Array.from(document.querySelectorAll('button.project-item'));
            const row = rows.find((r) => (r.getAttribute('title') || '').includes('Urchin-Browser'));
            if (!row) return { clicked: false };
            const del = row.querySelector('.__ubProjDel');
            if (!del) return { clicked: false };
            del.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return new Promise((resolve) => setTimeout(() => {
              resolve({
                clicked: true,
                asked: !!window.__ubDelAsked,
                hidden: row.style.display === 'none' || !document.body.contains(row),
              });
            }, 400));
          })()`)) as { clicked: boolean; asked?: boolean; hidden?: boolean };
          hiddenAfterDel = delResult.clicked && (delResult.hidden ?? false);
          confirmAsked = delResult.asked ?? false;
        }

        // 路径提示抑制：切换目录后 1.5s 内不应存在「已切换到工作目录」提示
        await wc.executeJavaScript(`window.__ubCwdPickerPick && window.__ubCwdPickerPick('C:/')`);
        await wait(1500);
        const noticeSuppressed = (await wc.executeJavaScript(`(() => {
          const notes = Array.from(document.querySelectorAll('.fp-notice'));
          return !notes.some((n) => /\\u5df2\\u5207\\u6362\\u5230\\u5de5\\u4f5c\\u76ee\\u5f55|\\u5df2\\u5728\\u5de5\\u4f5c\\u76ee\\u5f55/.test(n.textContent || ''));
        })()`)) as boolean;

        // dev.47：更新组件隐藏 CSS 已注入（dd-update 仅留版本行 + update-dot 隐藏）
        const updateCssReady = (await wc.executeJavaScript(`(() => {
          const st = document.getElementById('__ubProjStyle');
          const css = st ? st.textContent || '' : '';
          return css.includes('.dd-update>*:not(:first-child)') && css.includes('.update-dot');
        })()`)) as boolean;

        // dev.48：pi 页内 window.open 新开网页 → 标签图标钉定为 π
        //（先经主窗口开「链接新标签打开」，再从 pi 页开 example.com）
        await wc.executeJavaScript(`window.open('https://example.com')`);
        await wait(2500);

        return {
          theme,
          projectItems: counts.items,
          delButtons: counts.dels,
          hiddenAfterDel,
          confirmAsked,
          noticeSuppressed,
          updateCssReady,
          newChatMoved: newChat.origHidden && newChat.injected && newChat.rightAligned,
          themeSelectorHidden: !themeSel.present || themeSel.removed || themeSel.hidden,
        };
      },
      url,
    );
    expect(enhance).toMatchObject({
      theme: 'light',
      noticeSuppressed: true,
      updateCssReady: true,
      newChatMoved: true,
      themeSelectorHidden: true,
    });
    // 至少存在一个最近项目条目且确认后删除隐藏（5.6 刚切换过 → 必有）
    expect(enhance.projectItems ?? 0).toBeGreaterThanOrEqual(1);
    expect(enhance.hiddenAfterDel).toBe(true);
    // dev.47：删除经过确认判定（钩子被调用）
    expect(enhance.confirmAsked).toBe(true);

    // dev.49：主题即时直推——ui.theme.set 后主进程立刻向 pi 标签推送
    //（根治 dev.48 纯 2s 轮询的滞后/偶发失败「阻塞」）。往返断言：
    // 切暗 → pi 页移除 light 样式表 + 主题键清除（官方 dark=键缺失语义）；
    // 切亮 → pi 页恢复 light 样式表 + 主题键='light'。
    const invokeUiTheme = async (theme: 'dark' | 'light') => {
      await window.evaluate(async (t) => {
        const w = window as unknown as {
          urchin: { invoke: (c: string, r: unknown) => Promise<unknown> };
        };
        await w.urchin.invoke('ui.theme.set', { theme: t });
      }, theme);
    };
    const readPiThemeState = async (piUrl: string) =>
      electronApp.evaluate(
        async ({ webContents }, url): Promise<{ key: string | null; link: boolean }> => {
          const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(url));
          if (!wc) return { key: 'missing', link: false };
          return (await wc.executeJavaScript(`(() => ({
            key: localStorage.getItem('pi-web-ui:theme'),
            link: !!document.getElementById('theme-stylesheet'),
          }))()`)) as { key: string | null; link: boolean };
        },
        piUrl,
      );
    const waitPiThemeState = async (
      piUrl: string,
      want: (s: { key: string | null; link: boolean }) => boolean,
    ): Promise<boolean> => {
      for (let i = 0; i < 10; i++) {
        const st = await readPiThemeState(piUrl);
        if (want(st)) return true;
        await new Promise((r) => setTimeout(r, 300));
      }
      return false;
    };

    await invokeUiTheme('dark');
    expect(await waitPiThemeState(url, (s) => s.key === null && !s.link)).toBe(true);

    await invokeUiTheme('light');
    expect(await waitPiThemeState(url, (s) => s.key === 'light' && s.link)).toBe(true);

    // dev.48：pi 页打开的网页标签图标 = π（urchin://pi-icon 钉定）
    const tabList = await window.evaluate(async () => {
      const w = window as unknown as {
        urchin: {
          invoke: (
            c: string,
            r: unknown,
          ) => Promise<{ tabs?: { url?: string; favicon?: string }[] }>;
        };
      };
      return w.urchin.invoke('tab.list', {});
    });
    const exampleTab = (tabList.tabs ?? []).find((t) => (t.url ?? '').includes('example.com'));
    expect(exampleTab?.favicon).toBe('urchin://pi-icon/');

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
