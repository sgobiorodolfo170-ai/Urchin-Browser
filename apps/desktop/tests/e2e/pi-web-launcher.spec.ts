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
 * 7. dev.65：左区重构——自有面板（#__ubLeftPanel）就绪接管官方面板：上区
 *    「项目配置」（技能/插件启停 + .pi 配置文件）、下区「项目」（行切换 +
 *    行内「＋」/「×」+ 当前项目下挂对话/历史）；数据/动作经注入的第二条
 *    WebSocket（同 clientId 挂同一 ClientSession）走官方协议。
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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  // dev.88：插件左栏槽 fixture——向临时 profile 写入最小插件（leftpanel.sessions
  // 条目），验证官方槽在被我方接管（官方面板隐藏）后仍经镜像在我方面板可用。
  // 插件目录：<dataDir>/plugins/<id>/（dataDir = userData/pi/web-ui）。
  const pluginDir = join(userDataDir, 'pi', 'web-ui', 'plugins', 'e2e-lp');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'manifest.json'),
    `${JSON.stringify(
      { id: 'e2e-lp', name: 'E2E LP Slot', version: '1.0.0', apiVersion: 2, permissions: ['ui'] },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(pluginDir, 'index.mjs'),
    [
      'export default {',
      '  async activate(host) {',
      "    host.ui.register({ slot: 'leftpanel.sessions', id: 'hello', label: 'E2E槽按钮', kind: 'action', action: 'e2e-lp:hello' });",
      '  },',
      '};',
      '',
    ].join('\n'),
  );

  // dev.88：历史会话 fixture——leftpanel.sessions 槽条目按官方设计渲染在**每个
  // 会话/记录行**末尾，全新 profile 无会话行则槽容器不出现。预置一条最小 v3 会话
  //（格式见 vendor/pi/packages/coding-agent/docs/session-format.md），目录命名
  // `--<cwd 中 \\ / : 替换为 ->--`。
  const sessionCwd = join(userDataDir, 'pi', 'web-ui');
  const sessionDir = join(
    userDataDir,
    'pi',
    'agent',
    'sessions',
    `--${sessionCwd.replace(/[\\/:]/g, '-')}--`,
  );
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = '0199e2e0-0000-7000-8000-000000000001';
  writeFileSync(
    join(sessionDir, '2026-09-18T00-00-00-000Z_0199e2e0-0000-7000-8000-000000000001.jsonl'),
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: sessionId,
        timestamp: '2026-09-18T00:00:00.000Z',
        cwd: sessionCwd,
      }),
      JSON.stringify({
        type: 'message',
        id: 'e2e00001',
        parentId: null,
        timestamp: '2026-09-18T00:00:01.000Z',
        message: { role: 'user', content: 'E2E 会话 fixture' },
      }),
      '',
    ].join('\n'),
  );

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
      foldOk?: boolean;
      delRes?: { ok: boolean; reason?: string; title?: string };
      noticeSuppressed?: boolean;
      topbarClean?: { noOpenProject: boolean; noGithub: boolean; noVersion: boolean };
      lpReady?: boolean;
      lpOfficialHidden?: boolean;
      lpCfgRows?: number;
      lpProjRows?: number;
      lpActiveProj?: string;
      lpNewBtns?: number;
      lpSwitchWorked?: boolean;
      featureSurface?: {
        hasScheduler: boolean;
        hasTools: boolean;
        hasUiLayout: boolean;
        hasSubagentTpl: boolean;
        hasSkillsTab: boolean;
        hasExtsTab: boolean;
        hasAbout: boolean;
        aboutRowCount: number;
        aboutHasVersion: boolean;
        aboutNoUpdate: boolean;
      };
      featureProbe?: {
        notification: string;
        composerResize: boolean;
        quickChips: number;
        attachImg: boolean;
        swRegs: number;
        ua: string;
        setupModalVisible: boolean;
      };
      globalSearch?: { opened: boolean; hasPlaceholder: boolean };
      officialLeak?: string[];
      slotRes?: { official: boolean; mirrored: boolean; forwarded: boolean };
      cfgSkillsExpanded?: boolean;
      cfgExtsExpanded?: boolean;
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

        // 主题跟随浏览器（dev.48）：E2E 环境浏览器为亮色 → pi 应跟进 white 浅色主题
        let theme: string | null = null;
        for (let i = 0; i < 16; i++) {
          theme = (await wc.executeJavaScript(`localStorage.getItem('pi-web-ui:theme')`)) as
            string | null;
          if (theme === 'white') break;
          await wait(500);
        }

        // dev.65：左区重构——自有面板就绪接管（官方面板隐藏）+ 上区配置/下区项目结构。
        // 面板就绪依赖注入 ws 收到 snapshot（cwd），轮询等待稳定。
        interface LpStruct {
          ready?: boolean;
          officialHidden?: boolean;
          cfgRows?: number;
          projRows?: number;
          newBtns?: number;
          activeProj?: string;
        }
        let lp: LpStruct = {};
        for (let i = 0; i < 16; i++) {
          lp = (await wc.executeJavaScript(`(() => {
            const z = document.getElementById('__ubLeftPanel');
            const official = document.querySelector('.panel-left > .panel-projects');
            return {
              ready: !!(z && z.classList.contains('__ubReady')),
              officialHidden: !official || getComputedStyle(official).display === 'none',
              cfgRows: z ? z.querySelectorAll('.__ubLPCfgRow').length : 0,
              projRows: z ? z.querySelectorAll('.__ubLPProj').length : 0,
              newBtns: z ? z.querySelectorAll('.__ubNewBtn').length : 0,
              activeProj: z
                ? (z.querySelector('.__ubLPProj.active .__ubLPProjName')?.textContent ?? '')
                : '',
            };
          })()`)) as LpStruct;
          if (lp.ready === true) break;
          await wait(500);
        }

        // dev.88：插件左栏槽（leftpanel.sessions）断言在后段执行（经多次 cwd 切换与
        // 服务端 3s 会话缓存过期后历史行才渲染）——此处先占位。
        let slotRes: { official: boolean; mirrored: boolean; forwarded: boolean } = {
          official: false,
          mirrored: false,
          forwarded: false,
        };

        // dev.85：接管完整性——.panel-left 直接子节点中除我方 __ub* 外不得可见
        //（0.90 重构新增 panel-drawer/panel-rail 等结构时，防官方面板泄漏并与
        // 自有面板重叠渲染）
        const officialLeak = (await wc.executeJavaScript(`(() => {
          const lpRoot = document.querySelector('.panel-left');
          if (!lpRoot) return [];
          return Array.from(lpRoot.children)
            .filter((el) => !String(el.className || '').includes('__ub'))
            .filter((el) => {
              const cs = getComputedStyle(el);
              return cs.display !== 'none' && el.getBoundingClientRect().height > 0;
            })
            .map((el) => String(el.className));
        })()`)) as string[];

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

        // 5.6 已切换到 G:/ 仓库 → 官方「最近项目」区仍有条目（隐藏但保留 DOM，
        // 作为自有面板未就绪时的降级路径）且带删除按钮
        await wait(1000);
        const counts = (await wc.executeJavaScript(`(() => {
          const items = document.querySelectorAll('button.project-item');
          return { items: items.length, dels: document.querySelectorAll('.__ubProjDel').length };
        })()`)) as { items: number; dels: number };

        // 路径提示抑制（dev.64 修正选择器）：切换目录后 1.5s 内不应存在
        // 「已切换到工作目录」提示——0.29.x 官方 toast 是 .notice（fixed 居中，
        // 未抑制时 7s 自灭，此处 1.5s 检查足以捕捉回归）；.fp-notice 一并保留。
        await wc.executeJavaScript(`window.__ubCwdPickerPick && window.__ubCwdPickerPick('C:/')`);
        await wait(1500);
        let noticeSuppressed = (await wc.executeJavaScript(`(() => {
          const notes = Array.from(document.querySelectorAll('.fp-notice, .notice'));
          return !notes.some((n) => /\\u5df2\\u5207\\u6362\\u5230\\u5de5\\u4f5c\\u76ee\\u5f55|\\u5df2\\u5728\\u5de5\\u4f5c\\u76ee\\u5f55/.test(n.textContent || ''));
        })()`)) as boolean;

        // dev.84：0.90.0 起「最近项目」=保存记录+会话历史+当前 cwd（不再含进程 cwd），
        // 且服务端项目列表带 15s TTL 缓存——切换后短期窗口内列表=缓存+当前 cwd。
        // 因此目标取「非当前项目行」（窗口中必然存在的另一行），断言按该行 path
        // 动态比对（真实用户路径：点项目行 → set_cwd → cwd/active 跟随；toast 同抑制）。
        const targetPath = (await wc.executeJavaScript(
          `(document.querySelector('.__ubLPProj[data-act="proj"]:not(.active)')?.getAttribute('title') ?? '')`,
        )) as string;
        await wc.executeJavaScript(`(() => {
          const row = document.querySelector('.__ubLPProj[data-act="proj"]:not(.active)');
          if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        })()`);
        await wait(3000);
        const switchRaw = (await wc.executeJavaScript(`(() => {
          const cwdText =
            (document.querySelector('.__ubCwdRow .__ubCwdPath')?.textContent ?? '');
          const active = document.querySelector('.__ubLPProj.active');
          const notes = Array.from(document.querySelectorAll('.fp-notice, .notice'));
          return {
            cwdText,
            activeTitle: active ? (active.getAttribute('title') || '') : '',
            // dev.71：以活动项目行为作用域观测会话区（全局对话后各项目行都有会话区）
            activeHasList: (() => {
              const wrap = document.querySelector('.__ubLPProjWrap.active');
              return !!wrap && !!(wrap.querySelector('.__ubLPConvGroup') || wrap.querySelector('.__ubLPHint'));
            })(),
            stillSuppressed: !notes.some((n) =>
              /\\u5df2\\u5207\\u6362\\u5230\\u5de5\\u4f5c\\u76ee\\u5f55|\\u5df2\\u5728\\u5de5\\u4f5c\\u76ee\\u5f55/.test(n.textContent || ''),
            ),
          };
        })()`)) as {
          cwdText: string;
          activeTitle: string;
          activeHasList: boolean;
          stillSuppressed: boolean;
        };
        // 路径归一（反斜杠/正斜杠等价、大小写不敏感）后比对
        const normPath = (s: string): string => s.replace(/[\\/]+/g, '\\').toLowerCase();
        const switchOk =
          !!targetPath &&
          normPath(switchRaw.cwdText).includes(normPath(targetPath)) &&
          normPath(switchRaw.activeTitle) === normPath(targetPath);
        noticeSuppressed = noticeSuppressed && switchRaw.stillSuppressed;

        // dev.65：上区「项目配置」——展开技能小节（列表或空提示）与配置文件小节
        //（.pi 惰性加载：无目录则空提示），验证 set_settings / list_files 通道接线
        const cfgRes = (await wc.executeJavaScript(`(() => {
          const clickCfg = (v) => {
            const row = document.querySelector('.__ubLPCfgRow[data-v="' + v + '"]');
            if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return !!row;
          };
          return Promise.resolve()
            .then(() => ({ skillsClicked: clickCfg('skills') }))
            .then(() => new Promise((r) => setTimeout(() => r({
              skillsClicked: true,
              skillsExpanded: !!document.querySelector('.__ubLPItemList, .__ubLPHint'),
              extsClicked: clickCfg('exts'),
            }), 400)))
            .then(() => new Promise((r) => setTimeout(() => r({
              skillsClicked: true,
              skillsExpanded: !!document.querySelector('.__ubLPItemList, .__ubLPHint'),
              extsClicked: true,
              extsExpanded: !!document.querySelector('.__ubLPItemList, .__ubLPHint'),
            }), 400)));
        })()`)) as {
          skillsClicked: boolean;
          skillsExpanded: boolean;
          extsClicked: boolean;
          extsExpanded: boolean;
        };

        // dev.68：会话折叠/展开——「＋」前的 ▾ 按钮（默认展开；折叠后该行会话
        // 区消失，再点恢复）。dev.71 起断言以活动项目行为作用域（全局对话后
        // 各项目行都可能有会话区，全局计数不再有意义）。
        const foldRes = (await wc.executeJavaScript(`(() => {
          const clickFold = () => {
            const btn = document.querySelector('.__ubLPProj.active .__ubFoldBtn');
            if (!btn) return false;
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return true;
          };
          const activeWrapHasList = () => {
            const wrap = document.querySelector('.__ubLPProjWrap.active');
            return !!wrap && !!(wrap.querySelector('.__ubLPConvGroup') || wrap.querySelector('.__ubLPHint'));
          };
          const e0 = activeWrapHasList();
          const c1 = clickFold();
          return new Promise((resolve) => setTimeout(() => {
            const folded = !activeWrapHasList();
            const c2 = clickFold();
            setTimeout(() => resolve({
              ok: c1 && c2,
              expandedByDefault: e0,
              foldedAway: folded,
              restored: activeWrapHasList(),
            }), 250);
          }, 250));
        })()`)) as {
          ok: boolean;
          expandedByDefault: boolean;
          foldedAway: boolean;
          restored: boolean;
        };

        // dev.89（用户指令）：顶栏清理——打开项目 / GitHub / 版本更新入口全部移除；
        // 版本号移入设置导航最底部「关于」（只读弹窗，无自动更新入口）
        const topbarClean = (await wc.executeJavaScript(`(() => {
          const versionChip = Array.from(document.querySelectorAll('.chip-sub'))
            .some((s) => /^v?\\d+\\.\\d+\\.\\d+/.test((s.textContent || '').trim()));
          return {
            noOpenProject: !document.querySelector('button.chip.open-project'),
            noGithub: !document.querySelector('a.chip.github'),
            noVersion: !versionChip && !document.querySelector('.update-dot'),
          };
        })()`)) as { noOpenProject: boolean; noGithub: boolean; noVersion: boolean };

        // dev.85：功能面运行时核验——0.90 新增设置页（定时任务/工具/界面布局/子代理模板）
        // 全部保留（dev.86 已按决策清理已惰性的设置去重代码；上游设置页无「技能/插件」tab）；
        // 通知权限/Service Worker（PWA）、输入框拖高与快捷短语在位；Ctrl+K 全局搜索可打开。
        await wait(400);
        await wc.executeJavaScript(`(() => {
          const chips = Array.from(document.querySelectorAll('span.chip-sub'));
          const chip = chips.find((c) => /^(设置|settings)$/i.test((c.textContent || '').trim()));
          const btn = chip && chip.closest('button');
          if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        })()`);
        await wait(900);
        const featureSurface = (await wc.executeJavaScript(`(() => {
          const labels = Array.from(document.querySelectorAll('button.settings-tab .settings-tab-label')).map((t) => (t.textContent || '').trim());
          // dev.89：设置导航最底部「关于」——点击弹只读关于窗（含版本号）
          const aboutTab = document.querySelector('.__ubAboutTab');
          if (aboutTab) aboutTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          const about = document.getElementById('__ubAbout');
          const aboutText = about ? (about.textContent || '') : '';
          const aboutRowCount = about ? about.querySelectorAll('.__ubAboutRow').length : 0;
          const aboutHasVersion = /v\\d+\\.\\d+\\.\\d+/.test(aboutText) || aboutText.indexOf('—') >= 0;
          const aboutNoUpdate = aboutText.indexOf('自动更新') >= 0 && !about.querySelector('.dd-update');
          if (about) about.remove();
          const close = document.querySelector('.modal-close');
          if (close) close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return {
            hasScheduler: labels.some((l) => /定时任务/.test(l)),
            hasTools: labels.some((l) => /^工具$/.test(l)),
            hasUiLayout: labels.some((l) => /界面布局/.test(l)),
            hasSubagentTpl: labels.some((l) => /子代理模板/.test(l)),
            hasSkillsTab: labels.some((l) => /^技能$/.test(l)),
            hasExtsTab: labels.some((l) => /^插件$/.test(l)),
            hasAbout: !!aboutTab,
            aboutRowCount,
            aboutHasVersion,
            aboutNoUpdate,
          };
        })()`)) as {
          hasScheduler: boolean;
          hasTools: boolean;
          hasUiLayout: boolean;
          hasSubagentTpl: boolean;
          hasSkillsTab: boolean;
          hasExtsTab: boolean;
          hasAbout: boolean;
          aboutRowCount: number;
          aboutHasVersion: boolean;
          aboutNoUpdate: boolean;
        };
        const featureProbe = (await wc.executeJavaScript(`(async () => {
          const out = {
            notification: (typeof Notification !== 'undefined') ? Notification.permission : 'none',
            composerResize: !!document.querySelector('.composer-resize'),
            quickChips: document.querySelectorAll('.quick-chip').length,
            attachImg: !!document.querySelector('.btn.attach-img'),
            ua: navigator.userAgent,
            // dev.87：官方 setup 弹窗（未配置模型时出现）须被注入 CSS 取消
            setupModalVisible: (() => {
              const m = document.querySelector('.modal.setup-modal');
              if (!m) return false;
              const cs = getComputedStyle(m);
              return cs.display !== 'none' && m.getBoundingClientRect().height > 0;
            })(),
          };
          try {
            const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
            out.swRegs = regs.length;
          } catch (e) { out.swRegs = -1; }
          return out;
        })()`)) as {
          notification: string;
          composerResize: boolean;
          quickChips: number;
          attachImg: boolean;
          swRegs: number;
          ua: string;
          setupModalVisible: boolean;
        };
        // Ctrl+K 全局搜索（0.90 新增；验证 Urchin 内未被浏览器快捷键吞掉）
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['control'] });
        await wait(700);
        const globalSearch = (await wc.executeJavaScript(`(() => {
          const modal = document.querySelector('.gs-modal');
          const input = modal ? modal.querySelector('input') : null;
          const close = document.querySelector('.gs-close');
          if (close) close.click();
          return { opened: !!modal, hasPlaceholder: !!(input && input.getAttribute('placeholder')) };
        })()`)) as { opened: boolean; hasPlaceholder: boolean };

        // dev.88：插件左栏槽（leftpanel.sessions）断言（在 delRes 改变 cwd 之前：
        // 此时 cwd=dataDir、fixture 历史行已渲染）——官方槽条目在被隐藏的
        // .panel-sessions 行内保留 DOM，我方面板镜像渲染并转发点击到官方节点
        let slotPresence = { official: false, mirrored: false };
        for (let i = 0; i < 24; i++) {
          slotPresence = (await wc.executeJavaScript(`(() => ({
            official: !!document.querySelector('.lp-slot-sessions button.lp-slot-btn'),
            mirrored: Array.from(document.querySelectorAll('.__ubLPSlotBtn')).some((b) => (b.textContent || '').indexOf('E2E槽按钮') >= 0),
          }))()`)) as { official: boolean; mirrored: boolean };
          if (slotPresence.official && slotPresence.mirrored) break;
          await wait(500);
        }
        const slotForwarded = (await wc.executeJavaScript(`(async () => {
          const official = document.querySelector('.lp-slot-sessions button.lp-slot-btn');
          const mine = Array.from(document.querySelectorAll('.__ubLPSlotBtn')).find((b) => (b.textContent || '').indexOf('E2E槽按钮') >= 0);
          if (!official || !mine) return false;
          window.__e2eSlotClicks = 0;
          official.addEventListener('click', function () { window.__e2eSlotClicks++; }, true);
          mine.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 300));
          return window.__e2eSlotClicks > 0;
        })()`)) as boolean;
        slotRes = { ...slotPresence, forwarded: slotForwarded };

        // dev.86：项目删除迁移官方 remove_project——先造出第二个项目行（非活动），
        // 挂确认钩子后点行内 ×，断言：行消失（服务端持久 tombstone 广播刷新面板）
        await wc.executeJavaScript(`window.__ubCwdPickerPick && window.__ubCwdPickerPick('C:/')`);
        await wait(2000);
        const delRes = (await wc.executeJavaScript(`(async () => {
          window.__ubProjDelConfirm = function(){ return true; };
          const rows = Array.from(document.querySelectorAll('.__ubLPProj[data-act="proj"]'));
          const target = rows.find(function(r){ return !r.classList.contains('active'); });
          if (!target) return { ok: false, reason: 'no-non-active-row' };
          const title = target.getAttribute('title') || '';
          const btn = target.querySelector('[data-act="delproj"]');
          if (!btn) return { ok: false, reason: 'no-del-button', title };
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await new Promise(function(r){ setTimeout(r, 2500); });
          const still = Array.from(document.querySelectorAll('.__ubLPProj[data-act="proj"]'))
            .some(function(r){ return (r.getAttribute('title') || '') === title; });
          return { ok: !still, title };
        })()`)) as { ok: boolean; reason?: string; title?: string };

        // dev.48：pi 页内 window.open 新开网页 → 标签图标钉定为 π
        //（先经主窗口开「链接新标签打开」，再从 pi 页开 example.com）
        await wc.executeJavaScript(`window.open('https://example.com')`);
        await wait(2500);

        return {
          theme,
          projectItems: counts.items,
          delButtons: counts.dels,
          foldOk: foldRes.ok && foldRes.expandedByDefault && foldRes.foldedAway && foldRes.restored,
          delRes,
          noticeSuppressed,
          topbarClean,
          lpReady: lp.ready === true,
          lpOfficialHidden: lp.officialHidden === true,
          lpCfgRows: lp.cfgRows ?? 0,
          lpProjRows: lp.projRows ?? 0,
          lpActiveProj: lp.activeProj ?? '',
          lpNewBtns: lp.newBtns ?? 0,
          lpSwitchWorked: switchOk,
          featureSurface,
          featureProbe,
          globalSearch,
          officialLeak,
          slotRes,
          cfgSkillsExpanded: cfgRes.skillsClicked && cfgRes.skillsExpanded,
          cfgExtsExpanded: cfgRes.extsClicked && cfgRes.extsExpanded,
          themeSelectorHidden: !themeSel.present || themeSel.removed || themeSel.hidden,
        };
      },
      url,
    );
    // dev.85：功能面运行时核验——0.90 新设置页保留（去重仅移除技能/插件）、
    // 通知权限 granted / SW 已注册（PWA 面可用）、输入框拖高/快捷短语在位、
    // Ctrl+K 全局搜索在 Urchin 内可打开
    expect(enhance.featureSurface).toMatchObject({
      hasScheduler: true,
      hasTools: true,
      hasUiLayout: true,
      hasSubagentTpl: true,
      // dev.89：设置页「技能」「插件」页保留（左区与设置对齐的前提）；
      // 导航最底部「关于」只读弹窗（版本号 + 无自动更新入口）
      hasSkillsTab: true,
      hasExtsTab: true,
      hasAbout: true,
      aboutRowCount: 2,
      aboutHasVersion: true,
      aboutNoUpdate: true,
    });
    expect(enhance.featureProbe).toMatchObject({
      notification: 'granted',
      composerResize: true,
      attachImg: true,
    });
    expect(enhance.featureProbe?.quickChips ?? 0).toBeGreaterThanOrEqual(1);
    expect(enhance.featureProbe?.swRegs ?? 0).toBeGreaterThanOrEqual(1);
    expect(enhance.globalSearch).toMatchObject({ opened: true, hasPlaceholder: true });
    expect(enhance.officialLeak ?? []).toEqual([]);
    // dev.88：插件左栏槽接入——官方隐藏槽条目存在 + 我方面板镜像 + 点击转发生效
    expect(enhance.slotRes).toMatchObject({ official: true, mirrored: true, forwarded: true });
    // dev.86（A1 决策）：UA 中的 Electron 标记已抹除——pi 页按 Web 形态运行
    //（否则官方 isDesktop 判定会禁用浏览器操作/pageCall、更新面板走桌面分支）
    expect(enhance.featureProbe?.ua ?? '').not.toContain('Electron/');
    // dev.87：官方「未检测到 pi agent 配置」弹窗被注入 CSS 取消（不阻塞交互）
    expect(enhance.featureProbe?.setupModalVisible).toBe(false);

    expect(enhance).toMatchObject({
      theme: 'white',
      noticeSuppressed: true,
      topbarClean: { noOpenProject: true, noGithub: true, noVersion: true },
      themeSelectorHidden: true,
      // dev.65：左区重构——自有面板就绪接管 + 上下两区结构
      lpReady: true,
      lpOfficialHidden: true,
      lpSwitchWorked: true,
      cfgSkillsExpanded: true,
      cfgExtsExpanded: true,
    });
    // 至少存在一个最近项目条目（5.6 刚切换过 → 必有）
    expect(enhance.projectItems ?? 0).toBeGreaterThanOrEqual(1);
    // dev.68：会话折叠/展开正常（默认展开 → 折叠归零 → 恢复）；项目行无「×」删除按钮
    expect(enhance.foldOk).toBe(true);
    // dev.86：项目删除走官方 remove_project（持久 tombstone）——非活动行点 × 后消失
    expect(enhance.delRes?.ok).toBe(true);
    // dev.89：配置两小节（技能/插件，与设置页对齐；命令/预设/配置文件已移除）
    // + 项目行「＋」与行数一致
    expect(enhance.lpCfgRows).toBe(2);
    expect(enhance.lpProjRows ?? 0).toBeGreaterThanOrEqual(1);
    expect(enhance.lpNewBtns).toBe(enhance.lpProjRows);
    // dev.71：活动项目行展开且有会话区（组或空提示；全局对话后按行作用域观测）
    expect(enhance.lpSwitchWorked).toBe(true);
    // dev.84：0.90.0 起初始最近项目为 pi 数据目录（非进程 cwd），仅断言面板有活动项目行
    expect(enhance.lpActiveProj ?? '').not.toBe('');

    // dev.67：中区布局控制——折叠按钮 / 分割线拖拽 / 状态持久化 / 项目排序
    interface LayoutResult {
      error?: string;
      init?: { btns?: number; handles?: number; leftW?: number };
      collapsed?: boolean;
      expanded?: boolean;
      dragged?: { ok?: boolean; w0?: number; w1?: number };
      reorderFrom?: string;
      afterReorder?: string[];
      persisted?: { ready?: boolean; w?: number; paths?: string[] };
    }
    const layout = await electronApp.evaluate(
      async ({ webContents }, piUrl): Promise<LayoutResult> => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(piUrl));
        if (!wc) return { error: 'pi webContents not found' };
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const exec = (code: string) => wc.executeJavaScript(code) as Promise<unknown>;

        const init = (await exec(`(() => {
          const pane = document.querySelector('.layout > .view-pane main.main')?.closest('.view-pane');
          const left = pane?.querySelector('aside.panel-left');
          return {
            btns: [...document.querySelectorAll('#__ubLTCollapse, #__ubRTCollapse')].length,
            handles: document.querySelectorAll('.resize-handle.resize-left, .resize-handle.resize-right').length,
            leftW: left ? Math.round(left.getBoundingClientRect().width) : 0,
          };
        })()`)) as { btns: number; handles: number; leftW: number };

        // 折叠 → 左区隐藏；再点 → 展开
        await exec(`document.getElementById('__ubLTCollapse').click()`);
        await wait(250);
        const collapsed = (await exec(`(() => {
          const left = document.querySelector('.view-pane aside.panel-left');
          return !left || getComputedStyle(left).display === 'none' || !left.getBoundingClientRect().width;
        })()`)) as boolean;
        await exec(`document.getElementById('__ubLTCollapse').click()`);
        await wait(250);
        const expanded = (await exec(
          `!!document.querySelector('.view-pane aside.panel-left')?.getBoundingClientRect().width`,
        )) as boolean;

        // dev.71：拖拽原生把手（pointerdown → window pointermove/pointerup
        // 合成事件链——上游 Ns 组件用 pointer 事件 + window 监听）+120px
        // React onResize → setState → 异步渲染：派发事件后等渲染再量宽
        const drag0 = (await exec(`(() => {
          const h = document.querySelector('.resize-handle.resize-left');
          const left = document.querySelector('.view-pane aside.panel-left');
          if (!h || !left) return { ok: false };
          const w0 = left.getBoundingClientRect().width;
          const x = h.getBoundingClientRect().left + 3;
          const y = h.getBoundingClientRect().top + 40;
          const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, pointerId: 1 };
          h.dispatchEvent(new PointerEvent('pointerdown', o));
          const resizing = document.body.classList.contains('panel-resizing');
          window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x + 120 }));
          window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x + 120 }));
          return { ok: true, w0: Math.round(w0), resizing };
        })()`)) as { ok: boolean; w0?: number };
        await wait(600); // React 渲染 + 我方写入防抖 300ms 落盘
        const dragged = {
          ok: drag0.ok,
          resizing: (drag0 as { resizing?: boolean }).resizing,
          w0: drag0.w0,
          w1: (await exec(
            `Math.round(document.querySelector('.view-pane aside.panel-left')?.getBoundingClientRect().width ?? 0)`,
          )) as number,
        };

        // 项目排序：首位移到末尾（__reorder → urchin://pi-ui-state 持久化）
        const reorder = (await exec(`(() => {
          const rows = [...document.querySelectorAll('.__ubLPProj')];
          if (rows.length < 2 || !window.__ubPiUI) return '';
          const p = rows[0].getAttribute('data-v') || '';
          window.__ubPiUI.__reorder(p, '');
          return p;
        })()`)) as string;
        await wait(600);
        const afterReorder = (await exec(
          `[...document.querySelectorAll('.__ubLPProj')].map((r) => r.getAttribute('data-v'))`,
        )) as string[];

        // 重载页面：宽度与排序应从 urchin://pi-ui-state 恢复（跨「项目关闭再打开」）
        wc.reload();
        let persisted: { ready?: boolean; w?: number; paths?: string[] } = {};
        for (let i = 0; i < 24; i++) {
          await wait(500);
          persisted = (await exec(`(() => {
            const left = document.querySelector('.view-pane aside.panel-left');
            return {
              ready: !!(document.getElementById('__ubLeftPanel')?.classList.contains('__ubReady')),
              w: left ? Math.round(left.getBoundingClientRect().width) : 0,
              paths: [...document.querySelectorAll('.__ubLPProj')].map((r) => r.getAttribute('data-v')),
            };
          })()`)) as { ready?: boolean; w?: number; paths?: string[] };
          if (persisted.ready && (persisted.paths?.length ?? 0) >= Math.max(afterReorder.length, 1))
            break;
        }
        return {
          init,
          collapsed,
          expanded,
          dragged,
          reorderFrom: reorder,
          afterReorder,
          persisted,
        };
      },
      url,
    );
    expect(layout.error).toBeUndefined();
    expect(layout.init?.btns).toBe(2);
    expect(layout.init?.handles).toBeGreaterThanOrEqual(2);
    expect(layout.collapsed).toBe(true);
    expect(layout.expanded).toBe(true);
    expect(layout.dragged?.ok).toBe(true);
    expect((layout.dragged?.w1 ?? 0) - (layout.dragged?.w0 ?? 0)).toBeGreaterThanOrEqual(100);
    // 持久化：重载后宽度 = 拖拽后宽度；被移动到末尾的项目仍在末尾
    expect(layout.persisted?.w).toBe(layout.dragged?.w1);
    if ((layout.afterReorder?.length ?? 0) >= 2) {
      expect(layout.persisted?.paths?.[layout.persisted.paths.length - 1]).toBe(layout.reorderFrom);
    }

    // dev.49：主题即时直推——ui.theme.set 后主进程立刻向 pi 标签推送
    //（根治 dev.48 纯 2s 轮询的滞后/偶发失败「阻塞」）。往返断言：
    // 切暗 → pi 页移除 light 样式表 + 主题键清除（官方 dark=键缺失语义）；
    // 切亮 → pi 页恢复浅色样式表（white）+ 主题键='white'（dev.84 映射）。
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
    expect(await waitPiThemeState(url, (s) => s.key === 'white' && s.link)).toBe(true);

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
