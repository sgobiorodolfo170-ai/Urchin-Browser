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
 *
 * 2026-10-25 dev.119 功能扩展（用户需求）：
 * - 收藏夹 tab 目录化：面包屑导航 + 文件夹下钻（任意层级）+ 新建文件夹 +
 *   重命名（书签/文件夹均可，经 bookmark.update）+ 删除文件夹（级联，confirm 确认）
 * - 历史 tab 按访问日期分组「今天 / 昨天 / 10月18日」，组头可折叠，
 *   默认最近一组展开、其余折叠；无下级目录（纯展示层分组，无数据模型改动）
 * - 下载 tab：进度条 + 已下载/总大小 + 实时速度（500ms 轮询采样 EMA 平滑）+
 *   completed 状态「📂 在文件夹中显示」按钮（download.showInFolder IPC）
 */
import { BrowserWindow } from 'electron';
import { createLogger } from '@urchin/logger';

const log = createLogger('bookmark-panel');

/** 面板内联脚本（独立成函数便于 jsdom 单元测试执行真实交互）。
 *  IIFE 包裹：隔离顶层 const/let 作用域，jsdom 多测试用例共享同一 window
 *  重复执行脚本时不产生 "Identifier already declared" 冲突。 */
export function getBookmarkPanelScript(): string {
  return `
  (function () {
    const contentEl = document.getElementById('content');
    let activeTab = 'bookmarks';

    const ICONS = {
      bookmark: '⭐', history: '🕐', download: '⬇',
      folder: '📁', site: '🌐',
    };

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // 图标槽：优先显示主进程缓存的网站图标；加载失败时回退到 emoji，
    // 避免远程/缓存文件缺失时出现破图。
    function faviconSlot(favicon, fallback) {
      if (!favicon) {
        return '<span class="favicon-slot"><span class="icon favicon-fallback">' + fallback + '</span></span>';
      }
      return '<span class="favicon-slot">' +
        '<img class="favicon" src="' + escapeHtml(favicon) + '" alt="" />' +
        '<span class="icon favicon-fallback" style="display:none">' + fallback + '</span>' +
        '</span>';
    }

    function bindFaviconFallbacks(root) {
      (root || contentEl).querySelectorAll('img.favicon').forEach(img => {
        img.addEventListener('error', () => {
          img.style.display = 'none';
          const fallback = img.nextElementSibling;
          if (fallback) fallback.style.display = 'inline';
        });
      });
    }

    // 收藏夹面板数据源（经 preload 暴露的 typedInvoke，主进程 zod 校验）
    const invoke = (ch, req) => window.urchin.invoke(ch, req || {});

    // picker 模式（星标按钮未收藏时以 ?mode=picker 打开）：收藏夹 tab 进入「选择文件夹保存」
    const pickerMode = new URLSearchParams(location.search).get('mode') === 'picker';
    /** 待存页面上下文（picker 模式加载时经 ui.panel.getPickerContext 拉取）。 */
    let pickerContext = null;

    async function loadTab(tab) {
      stopDownloadPolling();
      activeTab = tab;
      document.querySelectorAll('.tab').forEach(el =>
        el.classList.toggle('active', el.dataset.tab === tab));
      try {
        if (tab === 'bookmarks') {
          if (pickerMode && !pickerContext) {
            const ctx = await invoke('ui.panel.getPickerContext', {});
            pickerContext = (ctx && typeof ctx === 'object') ? ctx : null;
          }
          await renderBookmarks();
        }
        else if (tab === 'history') await renderHistory();
        else await renderDownloads();
      } catch (e) {
        contentEl.innerHTML = '<div class="empty">加载失败：' + escapeHtml(String(e)) + '</div>';
      }
    }

    // ============================================================
    // 收藏夹 tab：目录导航（面包屑 + 文件夹下钻 + 新建/重命名/删除）
    // ============================================================

    /** 面板内导航状态：当前文件夹 ID（null = 根级）与面包屑轨迹（从根到当前）。 */
    let bmFolderId = null;
    let bmTrail = []; // [{ id, title }]，进入文件夹时追加

    /** 渲染收藏夹当前层：工具条（面包屑 + 新建文件夹）+ 列表（文件夹在前）。 */
    async function renderBookmarks() {
      const res = await invoke('bookmark.list', {});
      const all = res.bookmarks || [];

      // 面包屑标题刷新（外部可能已重命名/删除层级节点）
      bmTrail = bmTrail.filter(seg => all.some(b => b.id === seg.id));
      bmTrail.forEach(seg => {
        const node = all.find(b => b.id === seg.id);
        if (node && node.title) seg.title = node.title;
      });
      if (bmFolderId != null && !all.some(b => b.id === bmFolderId && b.type === 'folder')) {
        bmFolderId = null;
        bmTrail = [];
      }

      const children = all
        .filter(b => (b.parentId == null ? null : b.parentId) === bmFolderId)
        .sort((a, b) => (a.type === b.type ? a.position - b.position : (a.type === 'folder' ? -1 : 1)));

      let html =
        '<div class="bm-toolbar">' +
        '<div class="breadcrumb" id="bm-breadcrumb">' + renderBreadcrumb() + '</div>' +
        '<button class="new-folder-btn" id="bm-new-folder" title="新建文件夹">＋ 文件夹</button>' +
        '</div>';

      if (children.length === 0) {
        html += '<div class="empty">' + (bmFolderId ? '此文件夹为空' : '暂无书签') + '</div>';
      } else {
        html += children.map(b => (b.type === 'folder' ? renderFolderRow(b, all) : renderBookmarkRow(b))).join('');
      }
      // picker 模式：底部固定「保存到当前文件夹 / 取消」操作条
      if (pickerMode) {
        const curLabel = bmTrail.length > 0
          ? (bmTrail[bmTrail.length - 1] || {}).title || '当前文件夹'
          : '根目录';
        html += '<div class="picker-footer">'
          + '<span class="picker-target">保存到：' + escapeHtml(curLabel) + '</span>'
          + '<button class="picker-save" data-act="save-here">保存</button>'
          + '<button class="picker-cancel" data-act="picker-cancel">取消</button>'
          + '</div>';
      }
      contentEl.innerHTML = html;

      bindBreadcrumb();
      bindNewFolder();
      bindFaviconFallbacks();
      bindBookmarkRows();
      if (pickerMode) bindPickerActions();
    }

    /** 面包屑 HTML：「⌂ 收藏夹 › 文件夹A › 文件夹B」，每级可点击回跳。 */
    function renderBreadcrumb() {
      let html = crumbHtml(null, '⌂ 收藏夹');
      bmTrail.forEach(seg => {
        html += '<span class="crumb-sep">›</span>' + crumbHtml(seg.id, seg.title || '未命名文件夹');
      });
      return html;
    }

    function crumbHtml(id, label) {
      return '<span class="crumb" data-id="' + (id == null ? '' : escapeHtml(id)) + '">' +
        escapeHtml(label) + '</span>';
    }

    /** 面包屑跳转：目标为 null 回根级；否则按轨迹截断或从最新数据补全路径。 */
    async function jumpToFolder(id) {
      if (id == null) {
        bmFolderId = null;
        bmTrail = [];
      } else {
        const idx = bmTrail.findIndex(seg => seg.id === id);
        if (idx >= 0) {
          bmTrail = bmTrail.slice(0, idx + 1);
        }
        // 轨迹中不存在的 id（不应发生，防御式）：补一个标题占位段
        if (!bmTrail.some(seg => seg.id === id)) {
          bmTrail.push({ id, title: '未命名文件夹' });
        }
        bmFolderId = id;
      }
      await renderBookmarks();
    }

    function bindBreadcrumb() {
      contentEl.querySelectorAll('#bm-breadcrumb .crumb').forEach(el => {
        el.addEventListener('click', () => {
          void jumpToFolder(el.dataset.id || null);
        });
      });
    }

    /** 文件夹行：📁 名称 + 子项数 + 重命名/删除按钮；点击进入下级。 */
    function renderFolderRow(b, all) {
      const count = all.filter(x => x.parentId === b.id).length;
      const saveBtn = pickerMode
        ? '<button class="row-act" data-act="save-into" data-id="' + escapeHtml(b.id) + '" title="保存到此处">📥</button>'
        : '';
      return (
        '<div class="item folder-item" data-folder="' + escapeHtml(b.id) + '">' +
        '<span class="icon">' + ICONS.folder + '</span>' +
        '<div class="main"><div class="title">' + escapeHtml(b.title || '未命名文件夹') + '</div>' +
        '<div class="url">' + count + ' 项</div></div>' +
        '<div class="row-actions">' +
        saveBtn +
        '<button class="row-act" data-act="rename" data-id="' + escapeHtml(b.id) + '" title="重命名">✎</button>' +
        '<button class="row-act" data-act="delete" data-id="' + escapeHtml(b.id) + '" title="删除">✕</button>' +
        '</div></div>'
      );
    }

    /** 书签行：既有样式 + 重命名按钮（星标取消收藏保留）。 */
    function renderBookmarkRow(b) {
      return (
        '<div class="item" data-url="' + escapeHtml(b.url || '') + '">' +
        faviconSlot(b.favicon, ICONS.site) +
        '<span class="icon star" data-id="' + escapeHtml(b.id) + '" title="取消收藏">' + ICONS.bookmark + '</span>' +
        '<div class="main"><div class="title">' + escapeHtml(b.title || b.url || '') + '</div>' +
        '<div class="url">' + escapeHtml(b.url || '') + '</div></div>' +
        '<div class="row-actions">' +
        '<button class="row-act" data-act="rename" data-id="' + escapeHtml(b.id) + '" title="重命名">✎</button>' +
        '</div></div>'
      );
    }

    /** 绑定当前层交互：进入文件夹 / 打开书签 / 星标删除 / 重命名 / 删除。 */
    function bindBookmarkRows() {
      // 文件夹行 → 进入下级（行内按钮不触发）
      contentEl.querySelectorAll('.folder-item').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest && e.target.closest('.row-act, .rename-input')) return;
          const id = el.dataset.folder;
          bmFolderId = id;
          bmTrail.push({ id, title: (el.querySelector('.title') || {}).textContent || '未命名文件夹' });
          void renderBookmarks();
        });
      });

      // 书签行 → 在当前活跃标签页打开 URL
      contentEl.querySelectorAll('.item[data-url]').forEach(el => {
        if (!el.dataset.url) return;
        el.addEventListener('click', (e) => {
          if (e.target.closest && e.target.closest('.row-act, .star, .rename-input')) return;
          const url = el.dataset.url;
          invoke('tab.list', { windowId: 1 }).then(res => {
            const active = (res.tabs || []).find(t => t.active);
            if (active) return invoke('tab.loadUrl', { tabId: active.id, url });
            return undefined;
          }).catch(() => { /* ignore */ });
        });
      });

      // 星标取消收藏
      contentEl.querySelectorAll('.item .star').forEach(el => {
        el.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = el.dataset.id;
          if (!id) return;
          try {
            await invoke('bookmark.delete', { id });
            await renderBookmarks();
          } catch (err) { /* 忽略：删除失败保持现状 */ }
        });
      });

      // 行内操作：重命名 / 删除 / 保存到此文件夹（picker 模式）
      contentEl.querySelectorAll('.row-act').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          const id = btn.dataset.id;
          if (!act) return;
          if (act === 'rename' && id) startInlineRename(id);
          else if (act === 'delete' && id) void deleteBookmarkNode(id);
          else if (act === 'save-into' && id) void saveBookmarkTo(id);
        });
      });
    }

    /** picker 模式：底部「保存到当前文件夹 / 取消」操作条。 */
    function bindPickerActions() {
      const saveHere = contentEl.querySelector('[data-act="save-here"]');
      if (saveHere) {
        saveHere.addEventListener('click', (e) => {
          e.stopPropagation();
          void saveBookmarkTo(bmFolderId);
        });
      }
      const cancel = contentEl.querySelector('[data-act="picker-cancel"]');
      if (cancel) {
        cancel.addEventListener('click', (e) => {
          e.stopPropagation();
          invoke('ui.panel.close', {}).catch(() => { /* ignore */ });
        });
      }
    }

    /**
     * 保存当前页面到指定文件夹（picker 模式核心动作）。
     * parentId 为 null 时存根级；保存成功后关闭面板（主进程广播 bookmark:changed
     * → 主窗口星标亮起）。
     */
    async function saveBookmarkTo(parentId) {
      if (!pickerContext || !pickerContext.url) {
        // 上下文缺失（不应发生）：直接关闭
        try { await invoke('ui.panel.close', {}); } catch (err) { /* ignore */ }
        return;
      }
      try {
        await invoke('bookmark.create', {
          url: pickerContext.url,
          title: pickerContext.title || pickerContext.url,
          parentId: parentId == null ? null : parentId,
          type: 'bookmark',
        });
        await invoke('ui.panel.close', {});
      } catch (err) {
        // 保存失败：保持面板开启，用户可重试或取消
      }
    }

    /** 内联重命名：行内标题位替换为输入框（Enter 确认 / Esc 取消 / 失焦确认）。 */
    function startInlineRename(id) {
      const row = contentEl.querySelector('.row-act[data-id="' + cssEscape(id) + '"]');
      const item = row && row.closest && row.closest('.item');
      if (!item || item.querySelector('.rename-input')) return;
      const titleEl = item.querySelector('.title');
      if (!titleEl) return;
      const original = titleEl.textContent || '';
      titleEl.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'rename-input';
      input.value = original;
      titleEl.appendChild(input);
      input.focus();
      if (input.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length);
      let settled = false;
      const finish = (save) => {
        if (settled) return;
        settled = true;
        const next = String(input.value || '').trim();
        if (save && next && next !== original) {
          invoke('bookmark.update', { id, title: next })
            .then(() => renderBookmarks())
            .catch(() => renderBookmarks());
        } else {
          void renderBookmarks();
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    /** 朴素 id 转义（id 为 uuid，防御属性选择器语法字符）。 */
    function cssEscape(s) {
      return String(s || '').replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
    }

    /** 删除节点：文件夹级联需 confirm；删除所在层/祖先时回根目录。 */
    async function deleteBookmarkNode(id) {
      const res = await invoke('bookmark.list', {});
      const node = (res.bookmarks || []).find(b => b.id === id);
      if (!node) return;
      if (node.type === 'folder') {
        if (!window.confirm('删除文件夹「' + (node.title || '未命名') + '」及其全部内容？')) return;
      }
      try {
        await invoke('bookmark.delete', { id });
        if (bmFolderId === id || bmTrail.some(seg => seg.id === id)) {
          await jumpToFolder(null);
        } else {
          await renderBookmarks();
        }
      } catch (err) { /* 忽略：删除失败保持现状 */ }
    }

    /** 新建文件夹：工具条按钮原地展开输入框（当前层），Enter 确认 / Esc 取消。 */
    function bindNewFolder() {
      const btn = document.getElementById('bm-new-folder');
      if (!btn) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const toolbar = btn.parentElement;
        if (toolbar.querySelector('.rename-input')) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input new-folder-input';
        input.placeholder = '文件夹名称';
        toolbar.appendChild(input);
        input.focus();
        let settled = false;
        const finish = (save) => {
          if (settled) return;
          settled = true;
          const name = String(input.value || '').trim();
          if (save && name) {
            invoke('bookmark.create', {
              title: name,
              parentId: bmFolderId == null ? null : bmFolderId,
              type: 'folder',
            })
              .then(() => renderBookmarks())
              .catch(() => renderBookmarks());
          } else {
            void renderBookmarks();
          }
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') finish(true);
          else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('click', (ev) => ev.stopPropagation());
        input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      });
    }

    // 书签拖出浏览器窗口：自定义指针拖拽，指针移出面板窗口边界 →
    // 经 window.createWithUrl 在新浏览器窗口打开该 URL。
    // （v1 用系统拖放会生成桌面快捷方式；v2 改自定义拖拽，与 Chrome 拖出标签一致。）
    let dragBookmark = null;
    contentEl.addEventListener('pointerdown', (e) => {
      const item = e.target.closest && e.target.closest('.item');
      if (!item) return;
      // 星标/行内按钮/下载操作/重命名输入框不启动拖拽：setPointerCapture 会重定向
      // pointerup 目标，使随后的 click 派发到 .item 而非按钮——删除点击被劫持为打开网址。
      if (e.target.closest('.star') || e.target.closest('.row-act') ||
          e.target.closest('.dl-actions') || e.target.closest('.rename-input')) return;
      const url = item.dataset.url;
      if (!url) return;
      dragBookmark = { url, el: item, pointerId: e.pointerId };
      if (item.setPointerCapture) {
        try { item.setPointerCapture(e.pointerId); } catch (err) { /* 捕获失败忽略 */ }
      }
    });
    contentEl.addEventListener('pointermove', (e) => {
      if (!dragBookmark) return;
      // 指针移出面板窗口边界 → 在新窗口打开（定位到出界屏幕坐标，不重叠在面板窗口上）
      if (e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight) {
        const st = dragBookmark;
        dragBookmark = null;
        try { st.el.releasePointerCapture(st.pointerId); } catch (err) { /* 未捕获忽略 */ }
        invoke('window.createWithUrl', { url: st.url, x: e.screenX, y: e.screenY })
          .catch(() => { /* 打开失败静默 */ });
      }
    });
    const endBookmarkDrag = () => { dragBookmark = null; };
    contentEl.addEventListener('pointerup', endBookmarkDrag);
    contentEl.addEventListener('pointercancel', endBookmarkDrag);

    // ============================================================
    // 历史 tab：按访问日期分组（今天 / 昨天 / M月d日），组头可折叠
    // ============================================================

    /** 分组展开状态：dateKey → bool（面板生命周期内记忆用户选择）。 */
    let historyExpanded = {};
    /** 首次渲染标记：默认最近一组展开、其余折叠；之后沿用用户展开选择。 */
    let historyGroupsSeen = false;

    /** 历史日期标签：今天 / 昨天 / 其余「M月d日」。 */
    function historyDateLabel(ts) {
      const d = new Date(ts);
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const dayMs = 24 * 60 * 60 * 1000;
      if (ts >= todayStart) return '今天';
      if (ts >= todayStart - dayMs) return '昨天';
      return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }

    /** 分组键：本地日期 y-M-d（与标签解耦，跨月/跨年不冲突）。 */
    function historyDateKey(ts) {
      const d = new Date(ts);
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }

    async function renderHistory() {
      const res = await invoke('history.list', { limit: 100, offset: 0 });
      const items = res.entries || [];
      if (items.length === 0) {
        contentEl.innerHTML = '<div class="empty">暂无历史记录</div>';
        return;
      }

      // 按日期分桶（history.list 已按 visitedAt 降序，首个键即最近一组）
      const groups = [];
      const index = {};
      for (const h of items) {
        const key = historyDateKey(h.visitedAt);
        let g = index[key];
        if (!g) {
          g = { key, label: historyDateLabel(h.visitedAt), items: [] };
          index[key] = g;
          groups.push(g);
        }
        g.items.push(h);
      }
      if (!historyGroupsSeen) {
        groups.forEach((g, i) => { historyExpanded[g.key] = i === 0; });
        historyGroupsSeen = true;
      }

      contentEl.innerHTML = groups.map(g => {
        const expanded = !!historyExpanded[g.key];
        return (
          '<div class="date-group" data-key="' + escapeHtml(g.key) + '">' +
          '<div class="group-header"><span class="chevron">' + (expanded ? '▾' : '▸') + '</span>' +
          ICONS.folder + ' <span class="group-label">' + escapeHtml(g.label) + '</span>' +
          '<span class="group-count">' + g.items.length + '</span></div>' +
          (expanded ? '<div class="group-body">' + historyGroupBodyHtml(g.items) + '</div>' : '') +
          '</div>'
        );
      }).join('');

      bindFaviconFallbacks();
      bindHistoryItems(contentEl);

      // 组头点击：折叠/展开（仅重绘该组体，避免整页闪烁）
      contentEl.querySelectorAll('.group-header').forEach(el => {
        el.addEventListener('click', () => {
          const group = el.closest('.date-group');
          const key = group.dataset.key;
          historyExpanded[key] = !historyExpanded[key];
          const expanded = !!historyExpanded[key];
          el.querySelector('.chevron').textContent = expanded ? '▾' : '▸';
          const existing = group.querySelector('.group-body');
          if (expanded && !existing) {
            const body = document.createElement('div');
            body.className = 'group-body';
            const g = groups.find(x => x.key === key);
            body.innerHTML = historyGroupBodyHtml(g ? g.items : []);
            group.appendChild(body);
            bindFaviconFallbacks(body);
            bindHistoryItems(body);
          } else if (!expanded && existing) {
            existing.remove();
          }
        });
      });
    }

    function historyGroupBodyHtml(items) {
      return items.map(h => (
        '<div class="item hist-item" data-url="' + escapeHtml(h.url) + '">' +
        faviconSlot(h.favicon, ICONS.history) +
        '<div class="main"><div class="title">' + escapeHtml(h.title || h.url) + '</div>' +
        '<div class="url">' + escapeHtml(h.url) + '</div></div></div>'
      )).join('');
    }

    /** 历史条目点击 → 当前标签页打开（data-bound 去重防组体重复展开时双绑）。 */
    function bindHistoryItems(root) {
      root.querySelectorAll('.item[data-url]').forEach(el => {
        if (el.dataset.bound) return;
        el.dataset.bound = '1';
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

    // ============================================================
    // 下载 tab：进度条 + 速度 + 大小 + 在文件夹中显示（500ms 轮询）
    // ============================================================

    const DOWNLOAD_POLL_MS = 500;

    /** 轮询句柄：切离 downloads tab 时停止（面板窗口销毁随进程回收）。 */
    let downloadPollTimer = null;
    /** 上一轮采样：id → { received, t }（速度 = Δbytes / Δms）。 */
    let downloadSamples = {};
    /** 速度平滑值：id → bytes/s（EMA，抑制瞬时抖动）。 */
    let downloadSpeeds = {};

    function stopDownloadPolling() {
      if (downloadPollTimer) {
        clearInterval(downloadPollTimer);
        downloadPollTimer = null;
      }
    }

    function startDownloadPolling() {
      if (!downloadPollTimer) {
        downloadPollTimer = setInterval(() => { void renderDownloads(); }, DOWNLOAD_POLL_MS);
      }
    }

    function formatBytes(n) {
      if (!Number.isFinite(n) || n < 0) return '0 B';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
      return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function formatSpeed(bytesPerSec) {
      if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
      return formatBytes(bytesPerSec) + '/s';
    }

    const DOWNLOAD_STATE_TEXT = {
      completed: '已完成', progressing: '下载中', paused: '已暂停',
      cancelled: '已取消', interrupted: '已中断',
    };

    /** 速度采样（EMA 平滑）：基于上一轮 receivedBytes 计算瞬时速度后与历史值平均。 */
    function tickSpeed(id, received) {
      const now = Date.now();
      const prev = downloadSamples[id];
      downloadSamples[id] = { received, t: now };
      if (!prev) return downloadSpeeds[id] || 0;
      const dt = now - prev.t;
      if (dt <= 0) return downloadSpeeds[id] || 0;
      const inst = Math.max(0, (received - prev.received) * 1000 / dt);
      const prevSpeed = downloadSpeeds[id] || 0;
      const smoothed = prevSpeed > 0 ? prevSpeed * 0.5 + inst * 0.5 : inst;
      downloadSpeeds[id] = smoothed;
      return smoothed;
    }

    /** 进度百分比：completed=100；未知总量=-1（不定进度动画）。 */
    function downloadPercent(d) {
      if (d.state === 'completed') return 100;
      if (!d.totalBytes || d.totalBytes <= 0) return -1;
      return Math.min(100, (d.receivedBytes / d.totalBytes) * 100);
    }

    /** 元信息行：状态 + 大小（progressing 附加实时速度）。 */
    function downloadMetaText(d) {
      const state = DOWNLOAD_STATE_TEXT[d.state] || d.state;
      let text = state;
      if (d.state === 'progressing' || d.state === 'paused') {
        const size = d.totalBytes > 0
          ? formatBytes(d.receivedBytes) + ' / ' + formatBytes(d.totalBytes)
          : formatBytes(d.receivedBytes);
        text = size + (d.state === 'progressing'
          ? ' · ' + (formatSpeed(tickSpeed(d.id, d.receivedBytes)) || '…')
          : '');
      } else if (d.state === 'completed') {
        text = state + ' · ' + formatBytes(d.totalBytes || d.receivedBytes);
      }
      return text;
    }

    /** 操作按钮区 HTML（增量更新时与现有 DOM 比对，不一致触发整页重建）。 */
    function downloadActionsHtml(d) {
      const actions = [];
      if (d.state === 'progressing') actions.push('<button data-act="pause" data-id="' + escapeHtml(d.id) + '">暂停</button>');
      if (d.state === 'paused') actions.push('<button data-act="resume" data-id="' + escapeHtml(d.id) + '">恢复</button>');
      if (d.state === 'progressing' || d.state === 'paused') actions.push('<button data-act="cancel" data-id="' + escapeHtml(d.id) + '">取消</button>');
      if (d.state === 'completed') actions.push('<button data-act="show" data-id="' + escapeHtml(d.id) + '" title="在文件夹中显示">📂</button>');
      return '<div class="dl-actions">' + actions.join('') + '</div>';
    }

    /** 下载行 HTML：图标 + 文件名 + 元信息 + 进度条（progressing/paused）+ 操作。 */
    function downloadRowHtml(d) {
      const meta = downloadMetaText(d);
      const pct = downloadPercent(d);
      const indet = d.state === 'progressing' && pct < 0;
      return (
        '<div class="item dl-item' + (indet ? ' indeterminate' : '') + '" data-id="' + escapeHtml(d.id) + '">' +
        '<span class="icon">' + ICONS.download + '</span>' +
        '<div class="main">' +
        '<div class="title">' + escapeHtml(d.filename) + '</div>' +
        '<div class="url dl-meta">' + escapeHtml(meta) + '</div>' +
        (d.state === 'progressing' || d.state === 'paused'
          ? '<div class="progress-bar">' +
            '<div class="progress-bar-fill"' + (pct >= 0 ? ' style="width:' + pct.toFixed(1) + '%"' : '') + '></div>' +
            '</div>'
          : '') +
        '</div>' +
        downloadActionsHtml(d) +
        '</div>'
      );
    }

    async function renderDownloads() {
      let res;
      try {
        res = await invoke('download.list', {});
      } catch (err) {
        contentEl.innerHTML = '<div class="empty">加载失败：' + escapeHtml(String(err)) + '</div>';
        return;
      }
      const items = res.downloads || [];
      const existing = contentEl.querySelector('#dl-list');
      if (existing && activeTab === 'downloads' && items.length > 0 &&
          existing.querySelectorAll('.dl-item').length === items.length) {
        updateDownloadRows(items);
        return;
      }
      rebuildDownloadList(items);
    }

    /** 增量更新（常规轮询路径）：只改进度条宽度与元信息文字，不重建 DOM——
     *  保留 hover/进行中的点击；行数或操作区变化时退化为整页重建。 */
    function updateDownloadRows(items) {
      const byId = {};
      items.forEach(d => { byId[d.id] = d; });
      let needsRebuild = false;
      contentEl.querySelectorAll('.dl-item').forEach(row => {
        const d = byId[row.dataset.id];
        if (!d) { needsRebuild = true; return; }
        const actionsEl = row.querySelector('.dl-actions');
        if (actionsEl && actionsEl.innerHTML !== downloadActionsHtml(d)) { needsRebuild = true; return; }
        // 原地更新元信息与进度条
        const metaEl = row.querySelector('.dl-meta');
        if (metaEl) metaEl.textContent = downloadMetaText(d);
        const barEl = row.querySelector('.progress-bar-fill');
        if (barEl) {
          const pct = downloadPercent(d);
          if (d.state === 'progressing' && pct < 0) {
            row.classList.add('indeterminate');
          } else {
            row.classList.remove('indeterminate');
            if (pct >= 0) barEl.style.width = pct.toFixed(1) + '%';
          }
        }
      });
      if (needsRebuild) rebuildDownloadList(items);
    }

    function rebuildDownloadList(items) {
      if (items.length === 0) {
        contentEl.innerHTML = '<div class="empty">暂无下载记录</div>';
        return;
      }
      const rows = items.map(downloadRowHtml).join('');
      contentEl.innerHTML =
        '<div id="dl-list">' + rows + '</div>' +
        '<div class="clear-row"><button id="clear-downloads">清空已结束的下载</button></div>';
      bindDownloadActions();
      startDownloadPolling();
    }

    function bindDownloadActions() {
      contentEl.querySelectorAll('[data-act]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          const id = btn.dataset.id;
          try {
            if (act === 'pause') await invoke('download.pause', { id });
            else if (act === 'resume') await invoke('download.resume', { id });
            else if (act === 'cancel') await invoke('download.cancel', { id });
            else if (act === 'show') await invoke('download.showInFolder', { id });
            if (act !== 'show') await renderDownloads();
          } catch (err) { /* 忽略：操作失败保持现状 */ }
        });
      });
      const clearBtn = document.getElementById('clear-downloads');
      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          try { await invoke('download.clear', {}); await renderDownloads(); } catch { /* ignore */ }
        });
      }
    }

    document.querySelectorAll('.tab').forEach(el => {
      el.addEventListener('click', () => loadTab(el.dataset.tab));
    });

    loadTab('bookmarks');
  })();
  `;
}

/**
 * 收藏夹悬浮面板 HTML（urchin://panel 协议返回，单文件无外部依赖）。
 *
 * 内联脚本抽至 getBookmarkPanelScript() 以便 jsdom 单元测试执行真实交互
 * （星标删除 / 拖拽打开 / 文件夹导航等），此处仅做拼接。
 */
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
    /* 网站图标槽：固定 16px，图片加载失败时显示 emoji 回退 */
    .favicon-slot {
      width: 16px; height: 16px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .favicon { width: 16px; height: 16px; object-fit: contain; border-radius: 2px; }
    .favicon-fallback { width: 14px; }
    /* 收藏星标：可点击取消收藏（hover 变暗提示可点击） */
    .item .icon.star { cursor: pointer; }
    .item .icon.star:hover { filter: grayscale(0.5) brightness(0.7); }
    .item .main { flex: 1; min-width: 0; }
    .item .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item .url { color: var(--text-secondary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* ── 收藏夹目录化：工具条 / 面包屑 / 行内操作 ── */
    .bm-toolbar {
      display: flex; align-items: center; gap: 6px; padding: 6px 10px;
      border-bottom: 1px solid var(--border); background: var(--bg);
      min-height: 34px;
    }
    .breadcrumb {
      flex: 1; min-width: 0; font-size: 12px; display: flex; align-items: center;
      overflow: hidden; white-space: nowrap;
    }
    .crumb {
      color: var(--text-secondary); cursor: pointer; max-width: 96px;
      overflow: hidden; text-overflow: ellipsis;
    }
    .crumb:hover { color: var(--text); text-decoration: underline; }
    .crumb-sep { color: var(--text-secondary); margin: 0 2px; flex-shrink: 0; }
    .new-folder-btn {
      flex-shrink: 0; border: 1px solid var(--border); background: var(--bg);
      color: var(--text-secondary); font-size: 11px; padding: 2px 6px;
      border-radius: 4px; cursor: pointer;
    }
    .new-folder-btn:hover { background: var(--bg-secondary); color: var(--text); }
    .row-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .row-act {
      width: 20px; height: 20px; border: none; background: none; cursor: pointer;
      color: var(--text-secondary); font-size: 11px; line-height: 1;
      border-radius: 3px; display: flex; align-items: center; justify-content: center;
    }
    .row-act:hover { background: var(--bg); color: var(--text); }
    .item.folder-item .row-act { opacity: 0; }
    .item.folder-item:hover .row-act, .item.folder-item .row-act:focus { opacity: 1; }
    .item:not(.folder-item) .row-act { opacity: 0; }
    .item:not(.folder-item):hover .row-act,
    .item:not(.folder-item) .row-act:focus { opacity: 1; }
    .rename-input {
      width: 100%; max-width: 150px; font-size: 12px; padding: 1px 4px;
      border: 1px solid var(--primary); border-radius: 3px;
      background: var(--bg); color: var(--text); outline: none;
    }
    /* ── picker 模式底部操作条（保存到当前文件夹 / 取消） ── */
    .picker-footer {
      position: sticky; bottom: 0; display: flex; align-items: center; gap: 6px;
      padding: 8px 10px; border-top: 1px solid var(--border); background: var(--bg);
    }
    .picker-target {
      flex: 1; min-width: 0; font-size: 11px; color: var(--text-secondary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .picker-save {
      border: none; background: var(--primary); color: #fff; font-size: 12px;
      padding: 4px 12px; border-radius: 4px; cursor: pointer; flex-shrink: 0;
    }
    .picker-save:hover { filter: brightness(1.08); }
    .picker-cancel {
      border: 1px solid var(--border); background: var(--bg); color: var(--text-secondary);
      font-size: 12px; padding: 4px 10px; border-radius: 4px; cursor: pointer; flex-shrink: 0;
    }
    .picker-cancel:hover { background: var(--bg-secondary); color: var(--text); }
    /* ── 历史日期分组 ── */
    .date-group { border-bottom: 1px solid var(--border); }
    .group-header {
      display: flex; align-items: center; gap: 6px; padding: 7px 10px;
      font-size: 12px; color: var(--text-secondary); cursor: pointer;
      user-select: none; background: var(--bg);
    }
    .group-header:hover { background: var(--bg-secondary); color: var(--text); }
    .group-header .chevron { width: 12px; text-align: center; flex-shrink: 0; }
    .group-label { font-weight: 500; }
    .group-count {
      margin-left: auto; font-size: 11px; color: var(--text-secondary);
      background: var(--bg-secondary); border-radius: 8px; padding: 0 6px;
    }
    .group-body .item { padding-left: 22px; }
    /* ── 下载进度条 ── */
    .dl-item .main { display: flex; flex-direction: column; gap: 2px; }
    .progress-bar {
      height: 4px; border-radius: 2px; background: var(--bg-secondary);
      overflow: hidden; margin-top: 2px;
    }
    .progress-bar-fill {
      height: 100%; background: var(--primary); border-radius: 2px;
      transition: width 0.4s ease-out;
    }
    /* 未知总量：不定进度动画（滑块来回） */
    .dl-item.indeterminate .progress-bar-fill {
      width: 30% !important;
      animation: dlIndeterminate 1.2s ease-in-out infinite alternate;
    }
    @keyframes dlIndeterminate {
      from { margin-left: 0; }
      to { margin-left: 70%; }
    }
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
${getBookmarkPanelScript()}
  </script>
</body>
</html>`;
}

/** 面板窗口尺寸（悬浮小窗，避开底部地址栏与右侧边栏） */
export const PANEL_WIDTH = 280;
export const PANEL_HEIGHT = 430;
/**
 * 网页滚动条宽度（px）。
 *
 * 网页（BrowserView）的右/下滚动条紧贴两栏边界，面板需让出滚动条宽度，
 * 否则会盖住滑块。Windows 经典滚动条约 17px；overlay scrollbar（自动隐藏）为 0。
 * 取 17 覆盖经典样式。
 */
const SCROLLBAR_WIDTH = 17;
/** 面板与网页滚动条/两栏边界的间隙（px） */
const PANEL_GAP = 2;

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
  /**
   * 读取浏览器布局尺寸（右侧栏宽度 / 底部地址栏高度）。
   *
   * 面板定位避开两栏：x = 内容区右缘 - rightWidth - 面板宽 - 2px，
   * y = 内容区下缘 - bottomHeight - 面板高 - 2px（地址栏上方、右侧栏左侧）。
   */
  getLayout?: () => { rightWidth: number; bottomHeight: number };
  /** BrowserWindow 工厂（测试注入 mock，生产默认 new BrowserWindow） */
  createWindow?: (opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
}

export class BookmarkPanel {
  private panel: BrowserWindow | null = null;
  private readonly options: BookmarkPanelOptions;
  /** blur 关闭的时间戳：用于抑制"按钮 toggle 重开"竞态（见 toggle） */
  private blurClosedAt = 0;

  constructor(options: BookmarkPanelOptions) {
    this.options = options;
  }

  /** 是否已打开 */
  get isOpen(): boolean {
    return this.panel !== null && !this.panel.isDestroyed();
  }

  /** 切换开/关。返回切换后的状态。 */
  toggle(): boolean {
    // 竞态抑制：面板打开时点击收藏夹按钮，mousedown 会先使主窗口获得焦点 →
    // 面板 blur 关闭，随后 toggle IPC 才到达。若 300ms 内刚被 blur 关闭，
    // 本次 toggle 视为"按钮点击已通过 blur 关闭面板"，不重开（避免关后又开）。
    if (Date.now() - this.blurClosedAt < 300) {
      this.blurClosedAt = 0;
      return false;
    }
    if (this.isOpen) {
      this.close();
      return false;
    }
    this.open();
    return true;
  }

  /**
   * 打开面板（懒创建子窗口）。
   *
   * @param mode 'normal' = 三 tab 浏览（默认）；'picker' = 收藏夹 tab 进入「选择文件夹保存」模式
   *             （星标按钮未收藏时调用，面板加载 ?mode=picker，脚本据此渲染选择器）
   */
  open(mode: 'normal' | 'picker' = 'normal'): void {
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
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });

    // 定位：地址栏上方、右侧栏左侧（避开两栏）
    this.reposition(panel, parent);
    // 点击面板外任意处（主窗口/网页）自动关闭：
    // 面板以 show() 抢焦点 → 点击外部使主窗口获得焦点 → 面板 blur → 关闭
    panel.on('blur', () => {
      this.blurClosedAt = Date.now();
      this.close();
    });
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
    const url = mode === 'picker' ? 'urchin://panel?mode=picker' : 'urchin://panel';
    void panel.loadURL(url);
    // 等页面加载完成再显示，避免白屏；show() 抢焦点，使外部点击可触发 blur 关闭
    panel.once('ready-to-show', () => {
      if (!panel.isDestroyed()) panel.show();
    });
    log.info('bookmark panel opened', { mode });
  }

  /**
   * 以 picker 模式打开面板（星标按钮未收藏时调用）。
   *
   * 已打开（任意模式）则原地 reload 为 picker URL（复用窗口、避免重建闪烁）；
   * 未打开则新建并加载 picker URL。
   */
  openPicker(): void {
    if (this.isOpen && this.panel && !this.panel.isDestroyed()) {
      void this.panel.loadURL('urchin://panel?mode=picker');
      log.info('bookmark panel reloaded in picker mode');
      return;
    }
    this.open('picker');
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
   * 布局变化后刷新面板位置（如右侧栏宽度拖拽调节）。
   * 面板打开时按最新布局（右侧栏宽/地址栏高）重新定位。
   */
  refreshPosition(): void {
    if (!this.isOpen || !this.panel) return;
    const parent = this.options.getParentWindow();
    if (!parent) return;
    this.reposition(this.panel, parent);
  }

  /**
   * 计算面板位置：地址栏上方、右侧边栏左侧，且不遮挡网页的右/下滚动条。
   *
   * 网页（BrowserView）区域为 [leftWidth, 右缘-rightWidth] × [0, 下缘-bottomHeight]，
   * 其右/下滚动条紧贴两栏边界。面板需让出滚动条宽度（Windows 经典滚动条约 17px），
   * 再留 2px 间隙，避免盖住滑块：
   * - x = 内容区右缘 - 右侧栏宽 - 滚动条宽 - 面板宽 - 2
   * - y = 内容区下缘 - 地址栏高 - 滚动条宽 - 面板高 - 2
   * 布局尺寸来自 getLayout()（默认视为两栏折叠 44/48，与 view-integration 初始一致）。
   */
  private reposition(panel: BrowserWindow, parent: PanelHostWindow): void {
    const parentBounds = parent.getContentBounds();
    const layout = this.options.getLayout?.() ?? { rightWidth: 44, bottomHeight: 48 };
    const x =
      parentBounds.x +
      parentBounds.width -
      layout.rightWidth -
      SCROLLBAR_WIDTH -
      PANEL_WIDTH -
      PANEL_GAP;
    const y =
      parentBounds.y +
      parentBounds.height -
      layout.bottomHeight -
      SCROLLBAR_WIDTH -
      PANEL_HEIGHT -
      PANEL_GAP;
    panel.setPosition(Math.round(x), Math.round(y));
  }
}
