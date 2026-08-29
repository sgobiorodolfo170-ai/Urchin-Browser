/**
 * pi 模块「真实用户使用场景」E2E 共享驱动（pi-agent-build / pi-agent-tetris 复用）。
 *
 * 封装与 pi 前端自动化交互的样板逻辑，两个场景规格只保留各自的流程/断言：
 * - 启动真实 Electron 应用 + 主窗口错误采集
 * - pi 页面 executeJavaScript 封装（每次实时定位 pi webContents；evaluate 的 arg 传入 URL，规避闭包序列化问题）
 * - 页面就绪（注入标记）/ 目录切换 / 显式选择 MiMo V2.5（付费）模型 / 输入 + 真实受信点击发送
 * - 等 agent 空闲（stop 按钮消失）后才可发 follow-up
 * - 实时捕获前端 transcript（用户消息→思考→工具调用→结果）+ 工具调用序列 + 运行状态
 * - 独立真实运行 `node --test` / `node src/demo.js`（验证「真实测试运行」）
 * - 采集主窗口 + pi 页面双通道报错（0 未捕获）
 *
 * 长期有效的坑（来自 dev.62/dev.63 实测，勿回退）：
 * 1. `electronApp.evaluate` 回调被序列化到主进程执行，**不能闭包引用测试变量**（否则 ReferenceError），
 *    URL/参数必须经 `evaluate(fn, arg)` 的 `arg` 传入。
 * 2. 模型下拉是 Radix Dropdown：须 `pointerdown` 事件序列打开（`click` 无效）+ 等 `.dd-menu .dd-model-name`
 *    异步加载（最多 ~15s）；优先选**付费精确 "MiMo V2.5"**（"MiMo V2.5 Free" 有每日额度上限，连跑后
 *    `FreeUsageLimitError` 直接拒答），再退 DeepSeek V4 Flash / MiMo Free 兜底。
 * 3. 发送按钮在 DOM 有多份副本，须按 `display!=='none' && width>0` 取可见那只；且用 `sendInputEvent`
 *    真实受信点击（避免 programmatic `.click()` 自动化副作用）。
 * 4. **发 follow-up 前须等 agent 空闲**：文件落盘早于回合结束（agent 还会自己跑测试/demo），此时
 *    `.btn.send` 被 `.btn.stop` 替换，查不到可见 send；须轮询 `.btn.stop` 消失（=空闲）再输入发送。
 * 5. 注入到 executeJavaScript 的代码必须纯 JS（TS `as` 会抛 Uncaught SyntaxError）。
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join, resolve, dirname } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** desktop 应用根目录（dist/main 等构建产物所在；helper 位于 tests/e2e/helpers，往上三级） */
export const APP_DIR = resolve(__dirname, '..', '..', '..');

/** 未捕获/良性资源错误的排除正则（favicon CSP / 404 / 网络类） */
export const EXCLUDE_ERR_RE =
  /Refused to load the image|favicon\.(svg|ico)|status of 404|Failed to load resource|net::ERR_|ERR_CONNECTION/i;

/** pi 页面执行 JS 的可判别结果：ok=true 携带 value（可为 undefined，如语句式代码），ok=false 携带 error */
export type EvalResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** pi 输入区就绪状态 */
export interface ReadyState {
  enabled: boolean;
  enhance: boolean;
  picker: boolean;
}
/** 模型选择结果 */
export interface ModelSelResult {
  ok: boolean;
  picked?: string;
  why?: string;
}
/** 可见发送按钮几何/禁用态 */
export interface SendBtnShape {
  x: number;
  y: number;
  w: number;
  h: number;
  disabled: boolean;
}
/** 前端 transcript 快照（用于「同步展示全过程」） */
export interface PiSnapshot {
  roleBlocks: string[];
  tools: string[];
  stopRunning: boolean;
}
/** 独立真实运行结果 */
export interface TestRunResult {
  code: number;
  ok: boolean;
  output: string;
}

/** 启动真实 Electron 应用，返回主窗口与错误采集数组 */
export async function launchApp(): Promise<{
  electronApp: ElectronApplication;
  window: Page;
  mainErrors: string[];
}> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-piagent-'));
  const electronApp = await electron.launch({
    cwd: APP_DIR,
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
  const mainErrors: string[] = [];
  window.on('console', (msg) => {
    if (msg.type() === 'error') mainErrors.push(msg.text());
  });
  window.on('pageerror', (err) => mainErrors.push(err.message));
  await window.locator('[aria-label="右侧边栏"]').first().dblclick();
  await window
    .getByRole('button', { name: '新建标签' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  return { electronApp, window, mainErrors };
}

/**
 * pi 前端自动化驱动。将所有「与 pi 网页交互的样板」集中于此，两场景规格只写各自的流程与断言。
 */
export class PiDriver {
  private readonly electronApp: ElectronApplication;
  private readonly window: Page;
  private readonly piUrl: string;
  private readonly mainErrors: string[];
  /** 已捕获的工具调用序列（跨回合累积） */
  readonly toolCalls: string[] = [];
  /** 已捕获的 transcript 历史快照（跨回合累积，用于报告全过程） */
  readonly transcriptHistory: PiSnapshot[] = [];

  constructor(electronApp: ElectronApplication, window: Page, piUrl: string, mainErrors: string[]) {
    this.electronApp = electronApp;
    this.window = window;
    this.piUrl = piUrl;
    this.mainErrors = mainErrors;
  }

  /**
   * 打开 pi 模块并等待运行，返回已就绪的 driver。
   * 首次运行需确认第三方来源说明（本地标记可能已确认过，两条路径兼容）。
   */
  static async openAndReady(): Promise<PiDriver> {
    const { electronApp, window, mainErrors } = await launchApp();
    await window.getByRole('button', { name: 'AI 助手' }).click();
    const ackBtn = window.getByRole('button', { name: /我已知晓/ });
    try {
      await ackBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await ackBtn.click();
    } catch {
      /* 已确认过 */
    }

    let url: string | null = null;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const st = await window.evaluate(
        async (): Promise<{ state?: string; url?: string } | null> => {
          const w = window as unknown as {
            urchin?: {
              invoke: (c: string, r: unknown) => Promise<{ state?: string; url?: string }>;
            };
          };
          if (!w.urchin) return null;
          try {
            return await w.urchin.invoke('piWeb.status', {});
          } catch {
            return null;
          }
        },
      );
      if (st?.state === 'running' && typeof st.url === 'string') {
        url = st.url;
        break;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!url) throw new Error('piWeb.status 未进入 running');

    const driver = new PiDriver(electronApp, window, url, mainErrors);
    await driver.installErrorCapture();
    return driver;
  }

  /** 打开 pi 模块入口（供 openAndReady 之外的场景复用） */
  async openPiModule(): Promise<void> {
    await this.window.getByRole('button', { name: 'AI 助手' }).click();
  }

  /** 在主进程侧安装 pi 页面 console 错误采集（globalThis 通信，规避序列化闭包） */
  private async installErrorCapture(): Promise<void> {
    await this.electronApp.evaluate(({ webContents }, target: string): void => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(target));
      const g = globalThis as unknown as Record<string, unknown>;
      g.__piWc = wc ?? null;
      g.__piErrors = [] as unknown[];
      if (wc) {
        wc.on('console-message', (_e: unknown, level: number, message: string) => {
          if (level >= 3) (g.__piErrors as string[]).push(`console(${level}): ${message}`);
        });
      }
    }, this.piUrl);
  }

  /** 在 pi 页面执行 JS（每次实时定位 pi webContents；URL 经 evaluate arg 传入） */
  async piEval<T = unknown>(code: string): Promise<T> {
    const result = await this.electronApp.evaluate(
      async ({ webContents }, a: { c: string; u: string }): Promise<EvalResult<T>> => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(a.u));
        if (!wc) return { ok: false, error: 'no pi wc' };
        try {
          return { ok: true, value: (await wc.executeJavaScript(a.c, true)) as T };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      { c: code, u: this.piUrl },
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  /** 等待 pi 页面就绪（输入框可用 + 注入脚本就位） */
  async waitReady(): Promise<ReadyState> {
    for (let i = 0; i < 40; i++) {
      const x = await this.piEval<ReadyState>(`(() => {
        const ta = document.querySelector('.inputbar .inputbox-row textarea');
        return { enabled: !!ta && !ta.disabled, enhance: !!window.__ubPageEnhanceInstalled, picker: !!window.__ubCwdPickerInstalled };
      })()`);
      if (x?.enabled && x.enhance && x.picker) return x;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('pi 页面未就绪');
  }

  /** 设置隔离项目工作目录（复用 dir-picker 真实链路），并等待前端切换成功 */
  async setCwd(projectDir: string): Promise<void> {
    await this.piEval(`window.__ubCwdPickerPick(${JSON.stringify(projectDir)})`);
    for (let i = 0; i < 20; i++) {
      const txt = await this.piEval<string>(`(() => {
        const row = document.querySelector('.inputbar .__ubCwdPath');
        const btn = document.querySelector('button.status-cwd');
        return (btn ? btn.textContent : '') + (row ? row.textContent : '');
      })()`);
      if (typeof txt === 'string' && txt.includes('urchin-pi-')) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('pi 工作目录未切换到隔离项目目录');
  }

  /** agent 是否正在运行（stop 按钮存在 = 运行中，此时 send 按钮被替换） */
  async isRunning(): Promise<boolean> {
    return this.piEval<boolean>(`(() => !!document.querySelector('.inputbar .btn.stop'))()`);
  }

  /** 找到可见发送按钮（display!=='none' 且宽>0；DOM 有多份副本须过滤） */
  async findSendBtn(): Promise<SendBtnShape | null> {
    return this.piEval<SendBtnShape | null>(`(() => {
      const v = Array.from(document.querySelectorAll('.inputbar .btn.send')).filter(function(b){ return getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0; });
      if (!v.length) return null;
      const r = v[0].getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, disabled: v[0].disabled };
    })()`);
  }

  /** 等 agent 空闲（stop 消失）——发 follow-up 前必须调用（文件落盘早于回合结束） */
  async waitIdle(maxMs = 240_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!(await this.isRunning())) return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error('agent 未在限时内回到空闲');
  }

  /**
   * 显式选择模型：优先付费精确 "MiMo V2.5"，再退 DeepSeek V4 Flash / MiMo Free / 任意 MiMo。
   * 返回选择结果与选择后的当前模型名（供断言）。
   */
  async selectModel(): Promise<{ sel: ModelSelResult; currentModel: string | null }> {
    const sel = await this.piEval<ModelSelResult>(`(async () => {
      function fire(el) {
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function (t) {
          try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 })); } catch (e) {}
        });
      }
      const trig = document.querySelector('.inputbar .composer-tools-left .chip-model');
      if (!trig) return { ok: false, why: 'no chip-model' };
      const trigger = trig.closest('button') || trig.closest('[role="combobox"]') || trig.closest('.dropdown') || trig;
      fire(trigger);
      let target = null;
      for (let w = 0; w < 30; w++) {
        await new Promise(function (r) { setTimeout(r, 500); });
        const names = Array.from(document.querySelectorAll('.dd-menu .dd-model-name'));
        if (!names.length) continue;
        target = names.find(function (n) { return (n.textContent || '').trim() === 'MiMo V2.5'; }) ||
          names.find(function (n) { return /DeepSeek V4 Flash/i.test(n.textContent || ''); }) ||
          names.find(function (n) { return /MiMo V2\\.5 Free/i.test(n.textContent || ''); }) ||
          names.find(function (n) { return /MiMo/i.test(n.textContent || ''); });
        if (target) { fire(target); break; }
      }
      return target ? { ok: true, picked: (target.textContent || '').trim() } : { ok: false, why: 'no deepseek/mimo item' };
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    const currentModel = await this.piEval<string>(
      `(() => { const c = document.querySelector('.inputbar .composer-tools-left .chip-model'); return c ? (c.textContent || '').trim() : null; })()`,
    );
    return { sel, currentModel };
  }

  /** 输入并真实受信点击发送（先等 agent 空闲，再等可见 send 按钮） */
  async typeAndSend(text: string): Promise<void> {
    await this.waitIdle();
    await this.piEval(`(() => {
      const ta = document.querySelector('.inputbar .inputbox-row textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    let sendBtn: SendBtnShape | null = null;
    for (let i = 0; i < 25; i++) {
      sendBtn = await this.findSendBtn();
      if (sendBtn) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!sendBtn) throw new Error('发送按钮不可用');
    if (sendBtn.disabled) throw new Error('发送按钮被禁用');
    await this.electronApp.evaluate(
      ({ webContents }, a: { u: string; b: SendBtnShape }): Promise<void> => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(a.u));
        if (!wc) return Promise.resolve();
        const cx = Math.round(a.b.x + a.b.w / 2);
        const cy = Math.round(a.b.y + a.b.h / 2);
        wc.focus();
        wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
        return Promise.resolve();
      },
      { u: this.piUrl, b: sendBtn },
    );
  }

  /** 捕获一次前端 transcript 快照并入历史；工具调用去重累积 */
  async captureSnap(): Promise<PiSnapshot> {
    const snap = await this.piEval<PiSnapshot>(`(() => {
      const msgs = Array.from(document.querySelectorAll('.messages [data-role], .messages .msg'));
      const roleBlocks = msgs.map(function(m){
        var role = m.getAttribute('data-role') || (m.className || '').replace('msg-', '');
        var txt = (m.textContent || '').trim();
        return role + ':' + txt.length + ':' + txt.slice(0, 90);
      });
      const tools = Array.from(document.querySelectorAll('[class*="toolcall"], [class*="tool-call"], .toolcall-kill'));
      const toolText = tools.map(function(m){ return (m.textContent || '').trim().slice(0, 80); }).filter(function(t){ return t.length > 0; });
      const stop = document.querySelector('.inputbar .btn.stop');
      return { roleBlocks: roleBlocks.slice(-40), tools: toolText.slice(-25), stopRunning: !!stop };
    })()`);
    const last = this.transcriptHistory[this.transcriptHistory.length - 1];
    if (
      !this.transcriptHistory.length ||
      JSON.stringify(snap.roleBlocks) !== JSON.stringify(last?.roleBlocks)
    ) {
      this.transcriptHistory.push(snap);
    }
    for (const t of snap.tools) {
      if (!this.toolCalls.includes(t)) this.toolCalls.push(t);
    }
    return snap;
  }

  /** 把前端完整 transcript dump 到文件（过程可读复查）；返回文本或 null */
  async dumpTranscript(filePath: string): Promise<string | null> {
    try {
      const text = await this.piEval<string>(
        `(() => ((document.querySelector('.messages') || {}).innerText || ''))()`,
      );
      if (typeof text === 'string' && text.length) {
        writeFileSync(filePath, text, 'utf-8');
      }
      return typeof text === 'string' ? text : null;
    } catch {
      return null;
    }
  }

  /** 独立真实运行 node --test（验证「真实测试运行」，返回退出码/是否通过/输出） */
  runNodeTest(projectDir: string): TestRunResult {
    try {
      const out = execFileSync('node', ['--test'], { cwd: projectDir, encoding: 'utf-8' });
      return { code: 0, ok: true, output: out };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { code: err.status ?? -1, ok: false, output: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  }

  /** 独立真实运行 src/demo.js */
  runDemo(projectDir: string): TestRunResult {
    try {
      const out = execFileSync('node', ['src/demo.js'], { cwd: projectDir, encoding: 'utf-8' });
      return { code: 0, ok: true, output: out };
    } catch (e) {
      return { code: -1, ok: false, output: String(e) };
    }
  }

  /** 读取文件内容（不存在则空串） */
  readFileOrEmpty(projectDir: string, rel: string): string {
    try {
      return readFileSync(join(projectDir, rel), 'utf-8');
    } catch {
      return '';
    }
  }

  /** 采集主窗口 + pi 页面双通道未捕获报错（已排除良性资源错误） */
  async collectErrors(): Promise<{ main: string[]; pi: string[] }> {
    const piArr = await this.electronApp.evaluate(
      (): string[] => (globalThis as unknown as { __piErrors?: string[] }).__piErrors ?? [],
    );
    return {
      main: this.mainErrors.filter((e) => !EXCLUDE_ERR_RE.test(e)),
      pi: piArr.filter((e) => !EXCLUDE_ERR_RE.test(e)),
    };
  }

  /** 关闭应用 */
  async close(): Promise<void> {
    try {
      await this.electronApp.close();
    } catch {
      /* ignore */
    }
  }
}
