/**
 * 收藏夹悬浮面板（独立子窗口，悬浮于网页之上）
 *
 * 2026-08-14 设计（用户原始设计意图）：
 * - 点击地址栏收藏夹按钮 → 由下往上弹出小窗口，悬浮置顶在网页之上
 * - 只覆盖网页右下角弹窗面积（280×430），不隐藏、不让出网页
 *
 * 实现原理（Electron 层级约束）：
 * - BrowserView（网页）永远渲染在主窗口 webContents（React）之上，React 浮层
 *   无法盖住网页——因此面板必须用独立 BrowserWindow（子窗口）。
 * - BrowserWindow 始终渲染在 BrowserView 之上（不同顶层窗口），天然"悬浮置顶"。
 * - 子窗口复用主窗口 preload：加载 urchin://panel（特权协议），preload 按
 *   location.protocol==='urchin:' 暴露 window.urchin.invoke，面板内联 JS 直接调
 *   bookmark.list / history.list / download.list 等 IPC 拉取数据与操作。
 * - 自下而上动画：面板 HTML 内 CSS slide-up keyframes（子窗口定位在目标位置，
 *   内容从 translateY 滑入）。
 * - 点击外部自动关闭：子窗口 blur 事件（点击网页/主窗口时失焦）。
 * - 跟随主窗口：监听主窗口 move / resize 重定位（右下角吸附）。
 */
import { BrowserWindow } from 'electron';
import { createLogger } from '@urchin/logger';

const log = createLogger('bookmark-panel');

/** 面板窗口尺寸（与设计一致：右下角小窗） */
export const PANEL_WIDTH = 280;
export const PANEL_HEIGHT = 430;
/** 面板与主窗口内容区右/下边缘的间距（px） */
const PANEL_MARGIN = 8;

/** 面板 HTML（urchin://panel 协议返回，单文件无外部依赖） */
export function getBookmarkPanelHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>收藏夹</title>
  <style>
    :root {
      --bg: #ffffff; --bg-secondary: #f5f5f5; --border: #e5e5e5;
      --text: #1a1a1a; --text-secondary: #666666; --primary: #2563eb;
      --success: #16a34a; --warning: #d97706; --error: #dc2626;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1a1a1a; --bg-secondary: #262626; --border: #404040;
        --text: #f5f5f5; --text-secondary: #a3a3a3; --primary: #3b82f6;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg); color: var(--text); font-size: 13px;
      /* 自下而上弹出动画 */
      animation: slideUp 0.18s ease-out;
    }
    @keyframes slideUp {
      from { transform: translateY(24px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .tabs {
      display: flex; border-bottom: 1px solid var(--border); background: var(--bg);
    }
    .tab {
      flex: 1; padding: 9px 0; text-align: center; font-size: 12px;
      color: var(--text-secondary); cursor: pointer; border-bottom: 2px solid transparent;
      user-select: none;
    }
    .tab.active { color: var(--text); border-bottom-color: var(--primary); font-weight: 500; }
    .content { height: calc(100% - 38px); overflow-y: auto; }
    .empty { padding: 32px 0; text-align: center; color: var(--text-secondary); font-size: 12px; }
    .item {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      cursor: pointer; border-bottom: 1px solid var(--border);
    }
    .item:hover { background: var(--bg-secondary); }
    .item .icon { flex-shrink: 0; width: 14px; text-align: center; }
    .item .main { flex: 1; min-width: 0; }
    .item .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item .url { color: var(--text-secondary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dl-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .dl-actions button {
      border: 1px solid var(--border); background: var(--bg); color: var(--text);
      border-radius: 4px; font-size: 11px; padding: 2px 6px; cursor: pointer;
    }
    .dl-actions button:hover { background: var(--bg-secondary); }
    .dl-state { font-size: 11px; color: var(--text-secondary); }
    .clear-row { padding: 6px 10px; text-align: right; border-bottom: 1px solid var(--border); }
    .clear-row button {
      border: none; background: none; color: var(--text-secondary);
      font-size: 11px; cursor: pointer;
    }
    .clear-row button:hover { color: var(--text); }
  </style>
</head>
<body>
  <div class="tabs">
    <div class="tab active" data-tab="bookmarks">收藏夹</div>
    <div class="tab" data-tab="history">历史记录</div>
    <div class="tab" data-tab="downloads">下载列表</div>
  </div>
  <div class="content" id="content"><div class="empty">加载中…</div></div>

  <script>
    const contentEl = document.getElementById('content');
    let activeTab = 'bookmarks';

    const ICONS = { bookmark: '⭐', history: '🕐', download: '⬇', folder: '📁' };

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // 收藏夹面板数据源（经 preload 暴露的 typedInvoke，主进程 zod 校验）
    const invoke = (ch, req) => window.urchin.invoke(ch, req || {});

    async function loadTab(tab) {
      activeTab = tab;
      document.querySelectorAll('.tab').forEach(el =>
        el.classList.toggle('active', el.dataset.tab === tab));
      contentEl.innerHTML = '<div class="empty">加载中…</div>';
      try {
        if (tab === 'bookmarks') await renderBookmarks();
        else if (tab === 'history') await renderHistory();
        else await renderDownloads();
      } catch (e) {
        contentEl.innerHTML = '<div class="empty">加载失败：' + escapeHtml(String(e)) + '</div>';
      }
    }

    async function renderBookmarks() {
      const res = await invoke('bookmark.list', {});
      const items = (res.bookmarks || []).filter(b => b.type === 'bookmark' && b.url);
      if (items.length === 0) {
        contentEl.innerHTML = '<div class="empty">暂无书签</div>';
        return;
      }
      contentEl.innerHTML = items.map(b => (
        '<div class="item" data-url="' + escapeHtml(b.url) + '">' +
        '<span class="icon">⭐</span>' +
        '<div class="main"><div class="title">' + escapeHtml(b.title || b.url) + '</div>' +
        '<div class="url">' + escapeHtml(b.url) + '</div></div></div>'
      )).join('');
      bindOpen('.item');
    }

    async function renderHistory() {
      const res = await invoke('history.list', { limit: 100, offset: 0 });
      const items = res.entries || [];
      if (items.length === 0) {
        contentEl.innerHTML = '<div class="empty">暂无历史记录</div>';
        return;
      }
      contentEl.innerHTML = items.map(h => (
        '<div class="item" data-url="' + escapeHtml(h.url) + '">' +
        '<span class="icon">🕐</span>' +
        '<div class="main"><div class="title">' + escapeHtml(h.title || h.url) + '</div>' +
        '<div class="url">' + escapeHtml(h.url) + '</div></div></div>'
      )).join('');
      bindOpen('.item');
    }

    async function renderDownloads() {
      const res = await invoke('download.list', {});
      const items = res.downloads || [];
      if (items.length === 0) {
        contentEl.innerHTML = '<div class="empty">暂无下载记录</div>';
        return;
      }
      const stateText = {
        completed: '已完成', progressing: '下载中', paused: '已暂停',
        cancelled: '已取消', interrupted: '已中断',
      };
      contentEl.innerHTML = items.map(d => {
        const actions = [];
        if (d.state === 'progressing') actions.push('<button data-act="pause" data-id="' + escapeHtml(d.id) + '">暂停</button>');
        if (d.state === 'paused') actions.push('<button data-act="resume" data-id="' + escapeHtml(d.id) + '">恢复</button>');
        if (d.state === 'progressing' || d.state === 'paused') actions.push('<button data-act="cancel" data-id="' + escapeHtml(d.id) + '">取消</button>');
        return (
          '<div class="item">' +
          '<span class="icon">⬇</span>' +
          '<div class="main"><div class="title">' + escapeHtml(d.filename) + '</div>' +
          '<div class="url">' + escapeHtml((stateText[d.state] || d.state)) + '</div></div>' +
          (actions.length ? '<div class="dl-actions">' + actions.join('') + '</div>' : '') +
          '</div>'
        );
      }).join('') +
        '<div class="clear-row"><button id="clear-downloads">清空已结束的下载</button></div>';
      contentEl.querySelectorAll('[data-act]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          const id = btn.dataset.id;
          try {
            if (act === 'pause') await invoke('download.pause', { id });
            else if (act === 'resume') await invoke('download.resume', { id });
            else if (act === 'cancel') await invoke('download.cancel', { id });
            await loadTab('downloads');
          } catch (err) { /* 忽略：列表刷新失败保持现状 */ }
        });
      });
      const clearBtn = document.getElementById('clear-downloads');
      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          try { await invoke('download.clear', {}); await loadTab('downloads'); } catch { /* ignore */ }
        });
      }
    }

    // 点击书签/历史项 → 在当前活跃标签页打开 URL（与原 React 面板 onBookmarkNavigate 一致）
    function bindOpen(selector) {
      contentEl.querySelectorAll(selector).forEach(el => {
        el.addEventListener('click', async () => {
          const url = el.dataset.url;
          if (!url) return;
          try {
            const res = await invoke('tab.list', { windowId: 1 });
            const active = (res.tabs || []).find(t => t.active);
            if (active) await invoke('tab.loadUrl', { tabId: active.id, url });
          } catch { /* ignore */ }
        });
      });
    }

    document.querySelectorAll('.tab').forEach(el => {
      el.addEventListener('click', () => loadTab(el.dataset.tab));
    });

    loadTab('bookmarks');
  </script>
</body>
</html>`;
}

/**
 * 收藏夹悬浮面板管理器。
 *
 * 通过依赖注入（getParentWindow / preloadPath）保持可测试性：
 * 核心逻辑（toggle 状态机 / 定位计算）可单测，BrowserWindow 创建用 mock。
 *
 * PanelHostWindow 为最小结构类型：真实 Electron BrowserWindow 与
 * window-manager 的 BrowserWindowLike 均满足（均含 getContentBounds/on），
 * 避免强制 cast，同时便于测试注入 mock。
 */
export interface PanelHostWindow {
  getContentBounds(): { x: number; y: number; width: number; height: number };
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface BookmarkPanelOptions {
  /** 获取宿主主窗口（null = 主窗口尚未创建） */
  getParentWindow: () => PanelHostWindow | null;
  /** 主窗口 preload 脚本路径（子窗口复用，urchin:// 下暴露 window.urchin） */
  preloadPath: string;
  /** BrowserWindow 工厂（测试注入 mock，生产默认 new BrowserWindow） */
  createWindow?: (opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
}

export class BookmarkPanel {
  private panel: BrowserWindow | null = null;
  private readonly options: BookmarkPanelOptions;

  constructor(options: BookmarkPanelOptions) {
    this.options = options;
  }

  /** 是否已打开 */
  get isOpen(): boolean {
    return this.panel !== null && !this.panel.isDestroyed();
  }

  /** 切换开/关。返回切换后的状态。 */
  toggle(): boolean {
    if (this.isOpen) {
      this.close();
      return false;
    }
    this.open();
    return true;
  }

  /** 打开面板（懒创建子窗口）。 */
  open(): void {
    if (this.isOpen) return;
    const parent = this.options.getParentWindow();
    if (!parent) {
      log.warn('bookmark panel: parent window not available');
      return;
    }

    const create = this.options.createWindow ?? ((opts) => new BrowserWindow(opts));
    const panel = create({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      // 不抢焦点：showInactive 显示，点击面板内容时才获得焦点
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });

    // 定位：主窗口内容区右下角（吸附右下角，悬浮于网页之上）
    this.reposition(panel, parent);
    // 点击外部（主窗口/网页）自动关闭
    panel.on('blur', () => this.close());
    // 跟随主窗口移动/缩放
    const onParentMove = (): void => {
      if (this.isOpen && !panel.isDestroyed()) {
        this.reposition(panel, parent);
      }
    };
    parent.on('move', onParentMove);
    parent.on('resize', onParentMove);
    panel.on('closed', () => {
      parent.removeListener?.('move', onParentMove);
      parent.removeListener?.('resize', onParentMove);
      this.panel = null;
    });

    this.panel = panel;
    void panel.loadURL('urchin://panel');
    // 等页面加载完成再显示，避免白屏；showInactive 不抢焦点
    panel.once('ready-to-show', () => {
      if (!panel.isDestroyed()) panel.showInactive();
    });
    log.info('bookmark panel opened');
  }

  /** 关闭并销毁面板窗口。 */
  close(): void {
    if (this.panel && !this.panel.isDestroyed()) {
      this.panel.destroy();
    }
    this.panel = null;
    log.info('bookmark panel closed');
  }

  /**
   * 计算面板在主窗口内容区右下角的位置。
   * 吸附右下角：x = 主窗口内容区右缘 - 面板宽 - 边距；y = 内容区下缘 - 面板高 - 边距。
   */
  private reposition(panel: BrowserWindow, parent: PanelHostWindow): void {
    const parentBounds = parent.getContentBounds();
    const x = Math.max(
      parentBounds.x,
      parentBounds.x + parentBounds.width - PANEL_WIDTH - PANEL_MARGIN,
    );
    const y = Math.max(
      parentBounds.y,
      parentBounds.y + parentBounds.height - PANEL_HEIGHT - PANEL_MARGIN,
    );
    panel.setPosition(Math.round(x), Math.round(y));
  }
}
