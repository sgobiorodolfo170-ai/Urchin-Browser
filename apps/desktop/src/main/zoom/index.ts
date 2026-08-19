/**
 * 页面缩放模块 · Ctrl + 鼠标滚轮 放大/缩小网页
 *
 * 依据：02-架构设计 §4 安全边界 / M2 Tab Manager
 * 职责：
 * 1. 向每个 webContents（网页 tab + 主窗口内部页）注入 wheel 监听脚本：
 *    识别 Ctrl+滚轮后 preventDefault（阻止页面滚动），并 fetch urchin://zoom 通知主进程
 * 2. 主进程按方向调整 zoomFactor（向上放大 / 向下缩小），范围 25% ~ 500%
 * 3. 缩放状态由 Electron 按 webContents 持有（每标签独立、切 tab 保留），
 *    模块不维护额外状态，tab 销毁时自动释放
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「进程隔离」）：
 * - 修复根因（2026-08-18 用户反馈「未实现」）：第一版用 before-input-event 拦截滚轮，
 *   但 Electron 32 该事件只在键盘事件（PreHandleKeyboardEvent）时发射，滚轮永远不触发，
 *   功能完全不生效。v2 改为渲染进程 wheel 事件（有 deltaY/ctrlKey），再经
 *   urchin://zoom 特权协议通知主进程缩放——bypassCSP + supportFetchAPI + corsEnabled
 *   保证任意网页（含严格 CSP）均可 fetch，不受页面 CSP 限制
 * - 不用 preload 注入：固化教训 BrowserView 注入 preload 会阻塞网页加载
 *   （见 create-browser-view.ts 头部说明）；executeJavaScript 在 did-finish-load 后
 *   执行页面脚本，不阻塞加载
 * - 内部页（React 渲染于主窗口 webContents）与外部网页（BrowserView）分别注入
 *   不同 host 的脚本（zoom-main / zoom），缩放目标各自对应，互不串扰
 */
import type { TabManager } from '../tabs/tab-manager';
import type { TabSnapshot } from '../tabs/types';
import { createLogger } from '@urchin/logger';

const log = createLogger('zoom');

/** 每级滚轮缩放倍率（向上滚 ×1.1 放大，向下滚 ÷1.1 缩小） */
const ZOOM_STEP = 1.1;

/** 缩放下限（25%） */
const MIN_ZOOM = 0.25;

/** 缩放上限（500%，与 Chrome 一致） */
const MAX_ZOOM = 5;

/**
 * 计算下一个缩放倍率（纯函数，可单测）。
 *
 * 滚轮向上（deltaY<0）放大、向下缩小；deltaY=0 不变化；结果 clamp 到 [MIN_ZOOM, MAX_ZOOM]。
 */
export function computeZoomFactor(current: number, deltaY: number): number {
  if (deltaY === 0) return current;
  const next = deltaY < 0 ? current * ZOOM_STEP : current / ZOOM_STEP;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
}

/**
 * 按滚轮方向调整指定 webContents 的缩放（协议路由/cookie 通道共用入口）。
 *
 * 对缺失 API（测试 mock 或已销毁）静默跳过。
 */
export function applyZoomByDelta(wc: unknown, deltaY: number): void {
  const electronWc = wc as Electron.WebContents;
  if (!electronWc || typeof electronWc.getZoomFactor !== 'function') return;
  try {
    const next = computeZoomFactor(electronWc.getZoomFactor(), deltaY);
    if (next !== electronWc.getZoomFactor()) {
      electronWc.setZoomFactor(next);
    }
  } catch (err) {
    log.warn('zoom factor update failed', { error: String(err) });
  }
}

/**
 * 构建注入到页面的 wheel 监听脚本（纯函数，可单测）。
 *
 * 脚本行为：
 * - Ctrl+滚轮 → preventDefault 阻止页面滚动 + fetch('urchin://zoom[-main]?d=in|out')
 *   （mode:'no-cors'：简单请求，任意页面可发，响应无需读取）
 * - window.__ubZoomInstalled 标志位：同一文档重复注入（did-finish-load 重入）时跳过，
 *   避免监听叠加；整页导航后标志随文档重置，新文档重新注入
 *
 * @param fetchUrl 缩放通知 URL（主窗口内部页用 urchin://zoom-main，网页 tab 用 urchin://zoom）
 */
export function buildZoomInjectionScript(fetchUrl: string): string {
  return (
    '(function(){' +
    'if (window.__ubZoomInstalled) return;' +
    'window.__ubZoomInstalled = true;' +
    "window.addEventListener('wheel', function(e){" +
    'if (!e.ctrlKey) return;' +
    'e.preventDefault();' +
    "var d = e.deltaY < 0 ? 'in' : 'out';" +
    "try { fetch('" +
    fetchUrl +
    "?d=' + d, { mode: 'no-cors' }); } catch (err) {}" +
    '}, { passive: false });' +
    '})();'
  );
}

/**
 * 安装全局 Ctrl+滚轮缩放。
 *
 * 对每个网页 tab 的 webContents（created 事件 + 存量补装）与主窗口 webContents
 * 注入 wheel 监听脚本：did-finish-load 后注入（每次整页导航重新注入），
 * 已加载完成的立即补注入。缩放目标：tab → 网页缩放，主窗口 → 内部页缩放。
 *
 * @param tabManager 网页 tab 管理实例
 * @param mainWebContents 主窗口 webContents（可选；React 内部页缩放）
 * @returns 卸载函数（移除 created 与 did-finish-load 监听）
 */
export function installZoomControl(tabManager: TabManager, mainWebContents?: unknown): () => void {
  const disposers: (() => void)[] = [];

  /** 向单个 webContents 注入缩放脚本（挂 did-finish-load + 立即补注入）。 */
  const injectInto = (wc: unknown, fetchUrl: string): void => {
    const electronWc = wc as Electron.WebContents;
    if (!electronWc || typeof electronWc.on !== 'function') return;
    const inject = (): void => {
      try {
        // userGesture=true：注入脚本中的 fetch 视为用户手势发起，不受浏览器弹窗/自动播放策略限制
        void electronWc.executeJavaScript(buildZoomInjectionScript(fetchUrl), true).catch(() => {
          /* 忽略：页面正在卸载/导航时注入失败不影响下次 */
        });
      } catch {
        /* 忽略 */
      }
    };
    electronWc.on('did-finish-load', inject);
    disposers.push(() => {
      if (typeof electronWc.removeListener === 'function') {
        electronWc.removeListener('did-finish-load', inject);
      }
    });
    inject(); // 已加载完成的立即补注入（install 晚于首次导航时兜底）
  };

  const attachToTab = (snapshot: TabSnapshot): void => {
    const tab = tabManager.getTab(snapshot.id);
    if (tab) injectInto(tab.webContents, 'urchin://zoom');
  };
  tabManager.on('created', attachToTab);
  for (const snapshot of tabManager.query({})) {
    attachToTab(snapshot);
  }
  if (mainWebContents) injectInto(mainWebContents, 'urchin://zoom-main');

  return () => {
    tabManager.off('created', attachToTab);
    for (const dispose of disposers) {
      dispose();
    }
  };
}
