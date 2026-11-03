/**
 * 中转区 · 网页拖拽注入（路径 B）
 *
 * 复用 zoom 模块的"无 preload"通信模式（zoom/index.ts）：
 * - did-finish-load 后通过 executeJavaScript 注入脚本（不阻塞网页加载）
 * - 脚本监听 dragstart 事件，收集选中文字/链接/图片/视频信息
 * - 通过 fetch('urchin://transit-drag', { method: 'POST', body: JSON.stringify(data) })
 *   发送到主进程协议 handler（urchin:// 协议已 bypassCSP + corsEnabled）
 * - 幂等守卫 window.__urchinTransitDragInstalled 防止重复注入
 *
 * 与 P5（右键菜单加入中转区）互补：
 * - P5：右键 → 菜单项 → 加入（3 步）
 * - 路径 B：选中内容后拖动 → dragstart 自动加入（2 步）
 *
 * 设计理由（AGENTS.md §六 项目特化审查点「进程隔离」）：
 * - 不使用 BrowserView preload（固化教训：sandbox:true 下阻塞网页加载）
 * - executeJavaScript 在 did-finish-load 后执行，不影响页面加载
 * - urchin:// 特权协议保证任意网页（含严格 CSP）均可 fetch
 */
import type { TabManager } from '../tabs/tab-manager';
import type { TabSnapshot } from '../tabs/types';
import { createLogger } from '@urchin/logger';

const log = createLogger('transit-drag-injection');

/** 页面 dragstart 收集的数据（从注入脚本经协议 fetch 传到主进程） */
export interface TransitDragData {
  readonly kind: 'text' | 'link' | 'image' | 'video';
  readonly title: string;
  readonly text?: string;
  readonly url?: string;
  readonly linkText?: string;
  readonly pageUrl: string;
  readonly pageTitle: string;
}

/**
 * 构建注入到页面的 dragstart 监听脚本（纯函数，可单测）。
 *
 * 脚本行为：
 * - document.addEventListener('dragstart', ..., true) 捕获阶段监听
 * - 优先级：选中文字 > 链接（closest('a')）> 图片（IMG）> 视频（VIDEO）
 * - 通过 fetch('urchin://transit-drag', { method: 'POST', body: JSON.stringify(data) }) 发送
 * - window.__urchinTransitDragInstalled 幂等守卫
 */
export function buildDragInjectionScript(): string {
  return (
    '(function(){' +
    'if (window.__urchinTransitDragInstalled) return;' +
    'window.__urchinTransitDragInstalled = true;' +
    "document.addEventListener('dragstart', function(e){" +
    // 收集页面元信息
    'var pageUrl = location.href;' +
    "var pageTitle = document.title || '';" +
    // 优先：选中文字
    'var sel = window.getSelection();' +
    "var selText = sel ? sel.toString().trim() : '';" +
    'if (selText) {' +
    "  fetch('urchin://transit-drag', { method: 'POST', body: JSON.stringify({" +
    "    kind: 'text', title: selText.slice(0, 80), text: selText.slice(0, 500000)," +
    '    pageUrl: pageUrl, pageTitle: pageTitle' +
    '  }) }).catch(function(){});' +
    '  return;' +
    '}' +
    // 其次：链接
    "var a = e.target.closest ? e.target.closest('a') : null;" +
    'if (a && a.href) {' +
    "  var linkText = (a.textContent || '').trim();" +
    "  fetch('urchin://transit-drag', { method: 'POST', body: JSON.stringify({" +
    "    kind: 'link', title: linkText || a.href, url: a.href, linkText: linkText," +
    '    pageUrl: pageUrl, pageTitle: pageTitle' +
    '  }) }).catch(function(){});' +
    '  return;' +
    '}' +
    // 其次：图片
    'var tag = e.target.tagName;' +
    "if (tag === 'IMG' && e.target.src) {" +
    "  fetch('urchin://transit-drag', { method: 'POST', body: JSON.stringify({" +
    "    kind: 'image', title: e.target.alt || '图片', url: e.target.src," +
    '    pageUrl: pageUrl, pageTitle: pageTitle' +
    '  }) }).catch(function(){});' +
    '  return;' +
    '}' +
    // 最后：视频
    "if (tag === 'VIDEO') {" +
    "  var vUrl = e.target.src || e.target.currentSrc || '';" +
    '  if (vUrl) {' +
    "    fetch('urchin://transit-drag', { method: 'POST', body: JSON.stringify({" +
    "      kind: 'video', title: '视频', url: vUrl," +
    '      pageUrl: pageUrl, pageTitle: pageTitle' +
    '    }) }).catch(function(){});' +
    '  }' +
    '  return;' +
    '}' +
    // 非文字/链接/图片/视频：不处理
    '}, true);' +
    '})();'
  );
}

/**
 * 安装网页 dragstart 注入（installZoomControl 同款模式）。
 *
 * 对每个网页 tab 的 webContents：
 * - 挂 did-finish-load → executeJavaScript 注入脚本
 * - created 事件 + 存量补装
 *
 * @returns 卸载函数（移除 created 与 did-finish-load 监听）
 */
export function installDragInjection(tabManager: TabManager): () => void {
  const disposers: (() => void)[] = [];

  const injectInto = (wc: unknown): void => {
    const electronWc = wc as Electron.WebContents;
    if (!electronWc || typeof electronWc.on !== 'function') return;
    const inject = (): void => {
      try {
        void electronWc.executeJavaScript(buildDragInjectionScript(), true).catch(() => {
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
    inject();
  };

  const attachToTab = (snapshot: TabSnapshot): void => {
    const tab = tabManager.getTab(snapshot.id);
    if (tab) injectInto(tab.webContents);
  };
  tabManager.on('created', attachToTab);
  for (const snapshot of tabManager.query({})) {
    attachToTab(snapshot);
  }

  log.info('drag injection installed');

  return () => {
    tabManager.off('created', attachToTab);
    for (const dispose of disposers) {
      dispose();
    }
  };
}
