/**
 * pi 网页版 · 左区重构注入（dev.65，dev.66 会话合并，dev.68 启动防闪 + 配置面扩充）
 *
 * 用户需求（改变左区项目管理设定，仍分上下两区）：
 * - 上区（原「最近项目」）→ 「项目配置」：仅保留技能（含审查技能）与插件两组启停开关，
 *   与官方设置弹窗「技能」「插件」页对齐（同一 settings_state / set_settings 源）。
 *   dev.89（用户指令）：命令（slash_commands）、预设（应用/删除）、配置文件 .pi/ 编辑
 *   三组整体移除——上游设置页已有对应能力，避免重复建设。
 * - 下区（原「历史对话」）→ 「项目」管理区：每个项目一行（点击切换 = 原最近项目的
 *   管理全部移入），行内「＋」在对应项目下新建对话，「＋」前 ▾/▸ 折叠该项目的
 *   会话列表（默认展开，会话内记忆）；展开时下挂单一会话列表（dev.66：会话名
 *   统一取第一轮提问前几字，运行中对话排最上，streaming 优先）。
 *   dev.68：项目行「×」删除按钮曾按用户要求移除；**dev.86 决策恢复**——行内 ×
 *   走官方 `remove_project`（持久 tombstone，与官方最近项目删除同语义），确认语义
 *   保留 `__ubProjDelConfirm` 自动化钩子；旧 sessionStorage 隐藏列表已退役。
 *   dev.71（0.47.0）：conversations 广播跨项目全局——各项目运行对话按 cwd
 *   归位到各自项目行下；点击跨项目对话直发 switch_conversation（服务端已
 *   同步 set_cwd 全套副作用）。历史会话（sessions）上游仍按项目。
 *
 * 数据通道（关键设计）：注入脚本以 sessionStorage 的官方 clientId（pi-web-client-id）
 * 建立第二条 WebSocket——服务端 attach(clientId) 复用同一 ClientSession 并把新 socket
 * 加入广播集（emit 广播到所有 sink），因此：
 * - 收：projects / conversations / sessions / settings_state / ready（版本信息，
 *   供设置-关于读取）/ snapshot（cwd）全部广播；
 * - 发：set_cwd / new_chat / switch_conversation / switch_session / set_settings /
 *   remove_project 与官方 UI 同源（同一 ClientSession），状态变化经官方 UI
 *   自己的 socket 回流，React 自动刷新。
 *
 * 启动防闪（dev.68）：zone 创建即加 __ubOn 接管（骨架「左区加载中…」），配合
 * page-enhance 的 dom-ready 提前注入——官方旧 UI 从第一帧起就被隐藏；6s 未就绪
 * （ws 异常）撤下接管降级回官方面板，数据到达后重新接管。__ubReady 仅标记数据
 * 就绪（E2E 观测用）。
 *
 * 约束与取舍（不动第三方包源码原则不变）：
 * - 历史会话协议仍只提供「当前项目」的 sessions（上游未全局化）——非当前
 *   项目行下仅显示其运行对话（0.47.0 conversations 全局广播），历史仍需切换。
 * - 「＋」跨项目新建 = set_cwd 后等 snapshot 确认 cwd 已切换再发 new_chat
 *  （两条消息直发会交错：服务端 dispatch 不 await setCwd，new_chat 会落在旧
 *   cwd；switch_conversation 无此问题——服务端自己处理跨项目同步）。
 */

/**
 * 构建左区重构注入脚本（纯字符串，可单测）。
 *
 * 结构：状态 S ← WebSocket 广播；render() 以 innerHTML 重建自有面板
 * （#__ubLeftPanel，插入官方 aside.panel-left 首位——只追加自有节点、不移动
 * React 持有节点）；事件用面板根节点一次性委托（data-act 分发），重建无需重绑。
 */
export function buildLeftPanelScript(): string {
  return `(function () {
  if (window.__ubLeftPanelInstalled) return;
  window.__ubLeftPanelInstalled = true;

  // ── 状态（全部来自官方协议广播）──
  var S = {
    projects: [], conversations: [], activeId: null, sessions: [],
    cwd: '', settings: null,
    openCfg: '', pendNew: '', pendNewAt: 0,
    slotSig: '', sessRetry: 0,
  };
  var sock = null, retryTimer = null;

  // ── 数据通道：与官方页面同 clientId 的第二条 WebSocket ──
  function clientId() {
    try { return sessionStorage.getItem('pi-web-client-id') || ''; } catch (e) { return ''; }
  }
  function send(o) {
    if (sock && sock.readyState === 1) { try { sock.send(JSON.stringify(o)); } catch (e) {} }
  }
  function connect() {
    if (document.hidden) return;
    var id = clientId();
    if (!id) { clearTimeout(retryTimer); retryTimer = setTimeout(connect, 2000); return; }
    if (sock && sock.readyState <= 1) return;
    try {
      sock = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
    } catch (e) { clearTimeout(retryTimer); retryTimer = setTimeout(connect, 3000); return; }
    sock.onopen = function () {
      send({ type: 'hello', clientId: id });
      // attachSink 自动推 conversations/settings；projects/sessions 按需拉取
      send({ type: 'list_projects' });
      send({ type: 'list_sessions' });
    };
    sock.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      handle(m);
    };
    sock.onclose = function () {
      sock = null;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 3000);
    };
  }

  function handle(m) {
    if (m.type === 'ready') {
      // dev.89：捕获版本信息供「设置-关于」读取（前端版本 + 内置 pi SDK 版本）
      window.__ubPiVersions = { app: m.appVersion, server: m.serverVersion };
      return;
    }
    if (m.type === 'projects') { S.projects = m.projects || []; render(); }
    else if (m.type === 'conversations') { S.conversations = m.conversations || []; S.activeId = m.activeId; render(); }
    else if (m.type === 'sessions') {
      S.sessions = m.sessions || [];
      // dev.88：非空才重置重试计数（空回复可能是服务端 3s 会话缓存竞态，继续有限重试）
      if (S.sessions.length) S.sessRetry = 0;
      render();
    }
    else if (m.type === 'settings_state') { S.settings = m.settings || null; render(); }
    else if (m.type === 'snapshot') {
      // 流式期间快照 flood（~60ms/次）只做廉价 cwd 比对，无变化不重渲染
      var cwd = m.state && m.state.cwd;
      if (cwd && cwd !== S.cwd) {
        S.cwd = cwd;
        send({ type: 'list_projects' });
        send({ type: 'list_sessions' });
        // 跨项目「＋」：cwd 已切换到目标 → 补发 new_chat（避免落在旧 cwd）
        if (S.pendNew && S.pendNew === cwd) { S.pendNew = ''; send({ type: 'new_chat' }); }
        render();
      }
    }
  }

  // 跨项目新建兜底：8s 内 snapshot 未确认即放弃（服务端会另行弹错误 notice）；
  // dev.88：同时做插件左栏槽变更轮询（签名变化才重渲染）+ 空会话列表有限重试
  // （服务端 sessionInfosCache TTL 3s——首请求可能拿到竞态空缓存且无人再问）
  setInterval(function () {
    if (S.pendNew && Date.now() - S.pendNewAt > 8000) S.pendNew = '';
    var sig = slotSigOf(collectSlots());
    if (sig !== S.slotSig) { S.slotSig = sig; render(); }
    if (S.cwd && S.sessions.length === 0 && S.sessRetry < 3) { S.sessRetry++; send({ type: 'list_sessions' }); }
  }, 2000);

  // ── 插件左栏槽（leftpanel.sessions）镜像（dev.88，重叠项后续项）──
  // 官方槽位条目渲染在被接管的 .panel-sessions 内（display:none 但保留 DOM）：
  // 我方面板镜像渲染（按钮/下拉/徽标），交互转发到官方节点（不移动 React 节点）。
  function collectSlots() {
    var box = document.querySelector('.lp-slot-sessions');
    if (!box) return [];
    var out = [];
    for (var i = 0; i < box.children.length; i++) {
      var el = box.children[i];
      var cls = String(el.className || '');
      if (cls.indexOf('lp-slot-divider') >= 0) continue;
      var label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '';
      if (cls.indexOf('lp-slot-select') >= 0) {
        var opts = [];
        for (var j = 0; j < el.options.length; j++) {
          opts.push({ value: el.options[j].value, label: el.options[j].textContent || '' });
        }
        out.push({ kind: 'select', key: label + '#' + i, label: label, title: el.getAttribute('title') || '', value: el.value, options: opts, el: el });
      } else if (cls.indexOf('lp-slot-badge') >= 0) {
        out.push({ kind: 'badge', key: 'badge#' + i, label: label, title: el.getAttribute('title') || '' });
      } else if (cls.indexOf('lp-slot-btn') >= 0) {
        out.push({ kind: 'action', key: label + '#' + i, label: label, title: el.getAttribute('title') || '', el: el });
      }
    }
    return out;
  }
  function slotSigOf(items) {
    return JSON.stringify(items.map(function (it) { return [it.kind, it.key, it.label, it.value || '']; }));
  }
  function slotsHtml(items) {
    if (!items.length) return '';
    var h = '<div class="__ubLPSlots">';
    items.forEach(function (it) {
      var title = esc(it.title || it.label);
      if (it.kind === 'select') {
        h += '<select class="__ubLPSlotSel" data-act="slotsel" data-v="' + esc(it.key) + '" title="' + title + '">';
        it.options.forEach(function (o) {
          h += '<option value="' + esc(o.value) + '"' + (o.value === it.value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        });
        h += '</select>';
      } else if (it.kind === 'badge') {
        h += '<span class="__ubLPSlotBadge" title="' + title + '">' + esc(it.label) + '</span>';
      } else {
        h += '<button type="button" class="__ubLPSlotBtn" data-act="slot" data-v="' + esc(it.key) + '" title="' + title + '">' + esc(it.label) + '</button>';
      }
    });
    return h + '</div>';
  }
  function findSlot(key) {
    var items = collectSlots();
    for (var i = 0; i < items.length; i++) { if (items[i].key === key) return items[i]; }
    return null;
  }
  function setOfficialSelectValue(el, v) {
    try {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, v);
    } catch (e) { try { el.value = v; } catch (e2) {} }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── 工具 ──
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function baseName(p) { var a = String(p || '').split(/[\\\\/]/); return a[a.length - 1] || p; }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + '分';
    if (d < 86400000) return Math.floor(d / 3600000) + '时';
    var t = new Date(ts);
    return (t.getMonth() + 1) + '/' + t.getDate();
  }
  function toggleArr(arr, v) {
    var s = arr instanceof Array ? arr.slice() : [];
    var i = s.indexOf(v);
    if (i >= 0) s.splice(i, 1); else s.push(v);
    return s;
  }
  // 会话名（dev.66）：统一取第一轮提问前几字（运行对话的 title 服务端已按此生成
  // ——首个 user 消息规范化 + 30 字截断；历史会话 firstMessage 优先于自定义 name）
  var SESS_NAME_MAX = 30;
  function sessName(t) {
    var s = String(t == null ? '' : t).trim().replace(/\\s+/g, ' ');
    if (!s) s = '未命名会话';
    return s.length > SESS_NAME_MAX ? s.slice(0, SESS_NAME_MAX) + '…' : s;
  }
  // 项目排序（dev.67）：默认按持久化顺序（首见追加 ≈ 创建/加入顺序——协议无
  // 创建时间字段，以稳定为要义：使用项目/会话触发不改变顺序），支持手动拖拽
  //（window.__ubPiUI.__reorder 持久化）。状态未加载前维持服务端顺序。
  function orderedProjects(list) {
    var ui = window.__ubPiUI;
    if (!ui || !ui.loaded) return list;
    var po = ui.state.po || [];
    var known = [], unseen = [];
    list.forEach(function (p) { (po.indexOf(p.path) >= 0 ? known : unseen).push(p); });
    known.sort(function (a, b) { return po.indexOf(a.path) - po.indexOf(b.path); });
    if (unseen.length) {
      var live = {};
      list.forEach(function (p) { live[p.path] = true; });
      var merged = po.filter(function (pp) { return live[pp]; });
      unseen.forEach(function (p) { merged.push(p.path); });
      ui.state.po = merged;
      ui.save();
    }
    return known.concat(unseen);
  }

  // ── 面板根节点（一次性创建 + 一次性事件委托）──
  // dev.68：创建即接管（__ubOn）+ 骨架——配合 dom-ready 提前注入，官方旧 UI
  // 从启动第一帧起就被隐藏（根治「闪现修改前界面」）；6s 内未就绪（ws 异常）
  // 则撤下接管降级回官方面板，数据到达后 render 重新接管。
  var TAKEOVER_TIMEOUT_MS = 6000;
  function skeleton(z) {
    z.innerHTML = '<div class="__ubLPHint" style="padding:10px 12px">左区加载中…</div>';
  }
  function zoneEl() {
    var aside = document.querySelector('.panel.panel-left');
    if (!aside) return null;
    var z = document.getElementById('__ubLeftPanel');
    if (!z) {
      z = document.createElement('div');
      z.id = '__ubLeftPanel';
      z.className = '__ubLP __ubOn';
      aside.insertBefore(z, aside.firstChild);
      skeleton(z);
      z.addEventListener('click', onAction);
      // dev.88：插件左栏槽下拉镜像——转发到官方 select（原生 setter + change，
      // React onChange 与官方 w?.(item, value) 同语义）
      z.addEventListener('change', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-act="slotsel"]') : null;
        if (!el) return;
        var it = findSlot(el.getAttribute('data-v') || '');
        if (it && it.kind === 'select' && it.el) setOfficialSelectValue(it.el, el.value);
      });
      // dev.67：项目行拖拽排序（面板根一次性委托，innerHTML 重建免重绑）
      z.addEventListener('dragstart', onDragStart);
      z.addEventListener('dragover', onDragOver);
      z.addEventListener('drop', onDrop);
      z.addEventListener('dragend', onDragEnd);
      // dev.68：超时降级——官方面板恢复可见（ws 起不来时功能仍可用）
      setTimeout(function () {
        if (!z.classList.contains('__ubReady')) {
          z.classList.remove('__ubOn');
          z.innerHTML = '';
        }
      }, TAKEOVER_TIMEOUT_MS);
    }
    return z;
  }

  // ── 会话折叠（dev.68）：项目行「＋」前的 ▾/▸，默认展开，会话内记忆 ──
  var FOLD_KEY = '__ubFoldedProjs';
  function foldedSet() {
    try { return JSON.parse(sessionStorage.getItem(FOLD_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveFolded(l) {
    try { sessionStorage.setItem(FOLD_KEY, JSON.stringify(l)); } catch (e) {}
  }
  function isFolded(path) { return foldedSet().indexOf(path) >= 0; }
  function toggleFold(path) {
    var l = foldedSet();
    var i = l.indexOf(path);
    if (i >= 0) l.splice(i, 1); else l.push(path);
    saveFolded(l);
    render();
  }

  // ── 项目行拖拽排序（dev.67）──
  var dragPath = '';
  function clearDropMarks() {
    var marks = document.querySelectorAll('.__ubLPProjWrap.__ubDropBefore, .__ubLPProjWrap.__ubDropAfter');
    for (var i = 0; i < marks.length; i++) marks[i].classList.remove('__ubDropBefore', '__ubDropAfter');
  }
  function onDragStart(e) {
    var row = e.target && e.target.closest ? e.target.closest('.__ubLPProj') : null;
    if (!row) return;
    dragPath = row.getAttribute('data-v') || '';
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragPath); } catch (er) { /* IE 型接口缺失 */ }
    }
  }
  function onDragOver(e) {
    if (!dragPath) return;
    var row = e.target && e.target.closest ? e.target.closest('.__ubLPProj') : null;
    if (!row || row.getAttribute('data-v') === dragPath) { clearDropMarks(); return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    var wrap = row.closest('.__ubLPProjWrap');
    if (!wrap) return;
    var r = row.getBoundingClientRect();
    wrap.classList.add((e.clientY - r.top) > r.height / 2 ? '__ubDropAfter' : '__ubDropBefore');
  }
  function onDrop(e) {
    if (!dragPath) return;
    e.preventDefault();
    var row = e.target && e.target.closest ? e.target.closest('.__ubLPProj') : null;
    clearDropMarks();
    if (!row) return;
    var target = row.getAttribute('data-v') || '';
    if (!target || target === dragPath) { dragPath = ''; return; }
    var r = row.getBoundingClientRect();
    var after = (e.clientY - r.top) > r.height / 2;
    var ui = window.__ubPiUI;
    if (ui && typeof ui.__reorder === 'function') {
      var before = target;
      if (after) {
        var rows = document.querySelectorAll('.__ubLPProj');
        var paths = Array.prototype.map.call(rows, function (w) { return w.getAttribute('data-v'); });
        var idx = paths.indexOf(target);
        before = idx >= 0 && idx + 1 < paths.length ? paths[idx + 1] : '';
      }
      ui.__reorder(dragPath, before);
    }
    dragPath = '';
  }
  function onDragEnd() {
    dragPath = '';
    clearDropMarks();
  }
  // layout.ts 的 UI 状态就绪 / 排序变化 → 重渲染（含按 po 排序）
  document.addEventListener('__ubPiUIReady', function () { render(); });
  document.addEventListener('__ubPiUIOrder', function () { render(); });

  function cfgRow(key, name, cnt) {
    return '<button type="button" class="__ubLPCfgRow" data-act="cfg" data-v="' + key + '">' +
      '<span class="__ubLPChev">' + (S.openCfg === key ? '▾' : '▸') + '</span>' +
      '<span>' + name + '</span>' +
      '<span class="__ubLPCnt">' + esc(cnt) + '</span></button>';
  }
  function emptyHint(t) { return '<div class="__ubLPHint">' + esc(t) + '</div>'; }
  function nOn(a) { return a.filter(function (x) { return x.enabled; }).length; }

  function render() {
    var z = zoneEl();
    if (!z) return;
    // 未就绪（ws 数据未到）：保持接管 + 骨架（官方旧 UI 不闪现；超时由
    // zoneEl 的降级定时器兜底撤下）
    if (!S.cwd && !S.projects.length) { z.classList.remove('__ubReady'); skeleton(z); return; }
    z.classList.add('__ubOn');
    z.classList.add('__ubReady');

    var projects = orderedProjects(S.projects);
    var st = S.settings || {};
    var skills = st.skills || [], exts = st.extensions || [];

    var h = '';
    // ── 上区：项目配置 ──
    h += '<div class="__ubLPCfg">';
    h += '<div class="panel-section-title">项目配置<span class="__ubLPCfgProj" title="' + esc(S.cwd) + '">' + esc(baseName(S.cwd)) + '</span></div>';
    h += cfgRow('skills', '技能', S.settings ? (skills.length ? nOn(skills) + '/' + skills.length : '0') : '…');
    if (S.openCfg === 'skills') {
      if (skills.length) {
        h += '<div class="__ubLPItemList">';
        skills.forEach(function (s) {
          h += '<div class="__ubLPItem" title="' + esc(s.description || s.name) + '">' +
            '<span class="__ubLPItemName">' + esc(s.name) + '</span>' +
            '<button type="button" class="__ubLPSwitch' + (s.enabled ? ' on' : '') + '" data-act="skill" data-v="' + esc(s.name) + '"' +
            ' title="' + (s.enabled ? '停用' : '启用') + '"><i></i></button></div>';
        });
        h += '</div>';
      } else h += emptyHint('当前项目无技能（项目 .pi/skills/ 或用户级技能目录）');
      // dev.68：审查技能（reviewSkills——审查流程启用的另一组开关）
      var rsk = st.reviewSkills || [];
      if (rsk.length) {
        h += '<div class="__ubLPRGroup">审查技能</div>';
        h += '<div class="__ubLPItemList">';
        rsk.forEach(function (s) {
          h += '<div class="__ubLPItem" title="' + esc(s.description || s.name) + '">' +
            '<span class="__ubLPItemName">' + esc(s.name) + '</span>' +
            '<button type="button" class="__ubLPSwitch' + (s.enabled ? ' on' : '') + '" data-act="rskill" data-v="' + esc(s.name) + '"' +
            ' title="' + (s.enabled ? '停用' : '启用') + '"><i></i></button></div>';
        });
        h += '</div>';
      }
    }
    h += cfgRow('exts', '插件', S.settings ? (exts.length ? nOn(exts) + '/' + exts.length : '0') : '…');
    if (S.openCfg === 'exts') {
      if (exts.length) {
        h += '<div class="__ubLPItemList">';
        exts.forEach(function (x) {
          h += '<div class="__ubLPItem" title="' + esc(x.path || x.id) + '">' +
            '<span class="__ubLPItemName">' + esc(x.name) + '</span>' +
            '<button type="button" class="__ubLPSwitch' + (x.enabled ? ' on' : '') + '" data-act="ext" data-v="' + esc(x.id) + '"' +
            ' title="' + (x.enabled ? '停用' : '启用') + '"><i></i></button></div>';
        });
        h += '</div>';
      } else h += emptyHint('当前项目无插件');
    }
    // dev.89（用户指令）：命令 / 预设 / 配置文件 .pi/ 三组整体移除——
    // 上游设置页已有对应能力（预设管理等），避免重复建设；本区仅保留技能与插件。
    h += '</div>';

    // ── 下区：项目管理 ──
    var slots = collectSlots();
    S.slotSig = slotSigOf(slots);
    h += '<div class="__ubLPProjs"><div class="panel-section-title">项目</div>';
    h += slotsHtml(slots);
    h += '<div class="__ubLPScroll">';
    if (!projects.length) h += emptyHint('暂无项目');
    projects.forEach(function (p) {
      var act = p.path === S.cwd;
      var fold = isFolded(p.path);
      h += '<div class="__ubLPProjWrap' + (act ? ' active' : '') + '">';
      h += '<button type="button" class="__ubLPProj' + (act ? ' active' : '') + '" draggable="true" data-act="proj" data-v="' + esc(p.path) + '" title="' + esc(p.path) + '">' +
        '<span class="__ubLPChev">' + (fold ? '▸' : '▾') + '</span>' +
        '<span class="__ubLPProjName">' + esc(baseName(p.path)) + '</span>' +
        '<span class="__ubLPTime">' + esc(fmtTime(p.lastUsed)) + '</span>' +
        '<span class="__ubProjDel" data-act="delproj" data-v="' + esc(p.path) + '" title="从最近项目列表移除">×</span>' +
        '<span class="__ubFoldBtn" data-act="fold" data-v="' + esc(p.path) + '" title="' + (fold ? '展开会话' : '折叠会话') + '">' + (fold ? '▸' : '▾') + '</span>' +
        '<span class="__ubNewBtn" data-act="newchat" data-v="' + esc(p.path) + '" title="新建对话">＋</span>' +
        '</button>';
      if (!fold) {
        // dev.66：单一会话列表（不分对话/历史），会话名取第一轮提问前几字；
        // 运行中对话排最上（streaming 优先），其后历史会话（按 modified 降序）。
        // dev.71（0.47.0 全局对话）：conversations 广播跨项目全局——各项目的
        // 运行对话按 c.cwd 归位到各自项目行下（不再要求「展开即切换」）；
        // 历史会话仍仅当前项目（上游 sessions 未全局化）。点击跨项目对话
        // 直发 switch_conversation（上游已同步 cwd 全套副作用）。
        var convs = S.conversations.filter(function (c) { return c.cwd === p.path; })
          .sort(function (a, b) { return (b.isStreaming ? 1 : 0) - (a.isStreaming ? 1 : 0); });
        var sess = act ? S.sessions.slice(0, 50) : [];
        if (!convs.length && !sess.length) {
          h += '<div class="__ubLPHint" style="padding:2px 8px 6px">（暂无会话）</div>';
        } else {
          h += '<div class="__ubLPConvGroup">';
          convs.forEach(function (c) {
            h += '<button type="button" class="__ubLPConv __ubLPRunning' + (c.id === S.activeId ? ' active' : '') + '" data-act="conv" data-v="' + esc(String(c.id)) + '" title="' + esc(c.title || '') + '">' +
              '<span class="__ubLPConvTitle">' + esc(sessName(c.title)) + '</span>' +
              (c.isStreaming
                ? '<span class="__ubLPStream" title="生成中">●</span>'
                : '<span class="__ubLPSub">' + (c.messageCount || 0) + ' 条</span>') +
              '</button>';
          });
          sess.forEach(function (ss) {
            h += '<button type="button" class="__ubLPConv" data-act="sess" data-v="' + esc(ss.path) + '" title="' + esc(ss.path) + '">' +
              '<span class="__ubLPConvTitle">' + esc(sessName(ss.firstMessage || ss.name)) + '</span>' +
              '<span class="__ubLPSub">' + esc(fmtTime(ss.modified)) + '</span>' +
              '</button>';
          });
          h += '</div>';
        }
      }
      h += '</div>';
    });
    h += '</div></div>';
    z.innerHTML = h;
  }

  // ── 事件委托 ──
  function onAction(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var z = zoneEl();
    if (!z || !z.contains(el)) return;
    var act = el.getAttribute('data-act'), v = el.getAttribute('data-v');
    if (act === 'proj') {
      if (v !== S.cwd) send({ type: 'set_cwd', path: v });
    } else if (act === 'newchat') {
      if (v === S.cwd) send({ type: 'new_chat' });
      else { S.pendNew = v; S.pendNewAt = Date.now(); send({ type: 'set_cwd', path: v }); }
    } else if (act === 'fold') {
      // dev.68：折叠/展开该项目的会话列表（默认展开，会话内记忆）
      toggleFold(v);
    } else if (act === 'delproj') {
      // dev.86（决策）：项目删除改用官方 remove_project（服务端持久 tombstone，
      // 与官方最近项目删除同语义）；确认语义保留 __ubProjDelConfirm 自动化钩子
      var okDel = (typeof window.__ubProjDelConfirm === 'function')
        ? window.__ubProjDelConfirm(v)
        : window.confirm('确认从最近项目列表移除？\\n' + v);
      if (okDel) send({ type: 'remove_project', path: v });
    } else if (act === 'slot') {
      // dev.88：插件左栏槽按钮——转发点击到官方节点（React 动作原样触发）
      var slotItem = findSlot(v);
      if (slotItem && slotItem.el && typeof slotItem.el.click === 'function') slotItem.el.click();
    } else if (act === 'conv') {
      // dev.71：0.47.0 起运行对话跨项目全局，switch_conversation 跨项目时
      // 服务端已同步 set_cwd 全套副作用（文件树/会话历史/项目顺序/命令目录）
      if (v !== String(S.activeId)) send({ type: 'switch_conversation', id: Number(v) });
    } else if (act === 'sess') {
      send({ type: 'switch_session', path: v });
    } else if (act === 'skill') {
      send({ type: 'set_settings', disabledSkills: toggleArr((S.settings && S.settings.disabledSkills) || [], v) });
    } else if (act === 'rskill') {
      send({ type: 'set_settings', reviewDisabledSkills: toggleArr((S.settings && S.settings.reviewDisabledSkills) || [], v) });
    } else if (act === 'ext') {
      send({ type: 'set_settings', disabledExtensions: toggleArr((S.settings && S.settings.disabledExtensions) || [], v) });
    } else if (act === 'cfg') {
      S.openCfg = S.openCfg === v ? '' : v;
      render();
    }
  }

  // ── 样式（一次性注入）──
  var css =
    '.__ubLP{flex:1;min-height:0;display:flex;flex-direction:column;width:100%}' +
    // 优雅降级：面板就绪（拿到 cwd）才隐藏官方三区，ws 失败时官方行为完整保留
    // dev.68：接管类改为 __ubOn——zone 一创建（dom-ready 注入）即隐藏官方三区，
    // 根治启动闪现旧 UI；__ubReady 仅标记数据就绪（E2E 观测用）
    '.panel-left:has(>.__ubLP.__ubOn)>.panel-projects,' +
    '.panel-left:has(>.__ubLP.__ubOn)>.panel-convs,' +
    '.panel-left:has(>.__ubLP.__ubOn)>.panel-sessions{display:none!important}' +
    // dev.85：0.90 新增官方折叠按钮（panel-collapse-btn）与共享分割线（lp-sash）——
    // 与 dev.67 自绘折叠/原生把手持久化重复；定制优先，接管期隐藏官方重复件
    //（是否退役我方实现改用官方，列入重叠项报告待用户决策）
    '.panel-left:has(>.__ubLP.__ubOn)>.panel-collapse-btn,' +
    '.panel-left:has(>.__ubLP.__ubOn)>.lp-sash{display:none!important}' +
    '.__ubLPCfg{flex-shrink:0;max-height:45%;overflow-y:auto;padding:6px 6px 8px;border-bottom:2px solid var(--border)}' +
    '.__ubLPCfg .panel-section-title{display:flex;align-items:center;gap:6px}' +
    '.__ubLPCfgProj{font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-dim);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.__ubLPCfgRow{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:var(--text-dim);font-size:12.5px;text-align:left;cursor:pointer;margin-bottom:2px}' +
    '.__ubLPCfgRow:hover{background:var(--accent-soft)}' +
    '.__ubLPCnt{margin-left:auto;font-size:11px;color:var(--text-faint)}' +
    '.__ubLPChev{width:10px;flex-shrink:0;color:var(--text-faint);font-size:10px}' +
    '.__ubLPItemList{margin:0 0 4px 10px;border-left:2px solid var(--border);padding-left:4px}' +
    '.__ubLPItem{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:0 8px 8px 0;color:var(--text-dim);font-size:12px}' +
    '.__ubLPItemName{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.__ubLPSwitch{position:relative;width:26px;height:15px;border-radius:8px;border:none;background:var(--border);cursor:pointer;padding:0;flex-shrink:0}' +
    '.__ubLPSwitch i{position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:var(--text-dim);transition:transform .15s,background .15s}' +
    '.__ubLPSwitch.on{background:var(--accent)}' +
    '.__ubLPSwitch.on i{transform:translateX(11px);background:#fff}' +
    '.__ubLPHint{padding:4px 10px 8px;color:var(--text-faint);font-size:11.5px}' +
    '.__ubLPProjs{flex:1;min-height:0;display:flex;flex-direction:column;padding:0 6px}' +
    // dev.88：插件左栏槽镜像（leftpanel.sessions 条目 → 我方面板）
    '.__ubLPSlots{display:flex;flex-wrap:wrap;gap:4px;padding:2px 10px 6px}' +
    '.__ubLPSlotBtn{border:none;background:var(--accent-soft);color:var(--text-dim);font-size:11.5px;padding:3px 8px;border-radius:6px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.__ubLPSlotBtn:hover{color:var(--accent)}' +
    '.__ubLPSlotSel{background:var(--bg-elev2);color:var(--text-dim);border:1px solid var(--border);border-radius:6px;font-size:11.5px;padding:2px 4px;max-width:140px}' +
    '.__ubLPSlotBadge{font-size:11px;color:var(--text-faint);background:var(--bg-elev2);border-radius:6px;padding:2px 6px}' +
    '.__ubLPScroll{flex:1;overflow-y:auto;min-height:0;padding-bottom:56px}' +
    '.__ubLPProjWrap{margin-bottom:2px}' +
    // dev.67：拖拽排序落点指示（目标行上/下缘 accent 线）
    '.__ubLPProjWrap.__ubDropBefore{box-shadow:inset 0 2px 0 var(--accent)}' +
    '.__ubLPProjWrap.__ubDropAfter{box-shadow:inset 0 -2px 0 var(--accent)}' +
    '.__ubLPProj[draggable="true"]{cursor:grab}' +
    '.__ubLPProj{display:flex;align-items:center;gap:6px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:var(--text-dim);font-size:12.5px;text-align:left;cursor:pointer}' +
    '.__ubLPProj:hover{background:var(--accent-soft)}' +
    '.__ubLPProj.active{background:var(--accent-soft);color:var(--text);border:1px solid rgba(139,92,246,.3);padding:6px 9px}' +
    '.__ubLPProjName{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.__ubLPTime{font-size:10.5px;color:var(--text-faint);flex-shrink:0}' +
    // dev.86：项目删除入口（官方 remove_project，持久 tombstone；悬停行时显形）
    '.__ubProjDel{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;color:#e5484d;font-size:12px;line-height:1;opacity:0;transition:opacity .12s;cursor:pointer;flex-shrink:0}' +
    '.__ubLPProj:hover .__ubProjDel{opacity:1}' +
    '.__ubProjDel:hover{background:rgba(229,72,77,.12)}' +
    '.__ubNewBtn{width:20px;height:20px;line-height:18px;text-align:center;border-radius:5px;color:var(--text-dim);flex-shrink:0;font-size:13px}' +
    '.__ubNewBtn:hover{background:var(--accent);color:#fff}' +
    // dev.68：「＋」前的会话折叠/展开按钮（默认展开 ▾）
    '.__ubFoldBtn{width:18px;height:20px;line-height:18px;text-align:center;color:var(--text-faint);flex-shrink:0;font-size:11px}' +
    '.__ubFoldBtn:hover{color:var(--accent)}' +
    // dev.68：审查技能子标题（命令来源/预设删除样式随 dev.89 移除一并退役）
    '.__ubLPRGroup{padding:6px 10px 2px;font-size:10px;font-weight:700;letter-spacing:.5px;color:var(--text-faint)}' +
    '.__ubLPConvGroup{margin:0 0 6px 14px;border-left:2px solid var(--border);padding-left:4px}' +
    // 运行中对话（列表最上）：正文色 + 标题前小圆点，与历史会话（次级色）区分
    '.__ubLPRunning{color:var(--text)}' +
    '.__ubLPRunning .__ubLPConvTitle::before{content:"";display:inline-block;width:6px;height:6px;' +
    'border-radius:50%;background:var(--accent);margin-right:6px;vertical-align:middle}' +
    '.__ubLPConv{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:none;border-radius:0 8px 8px 0;background:transparent;color:var(--text-dim);font-size:12px;text-align:left;cursor:pointer;margin-bottom:1px}' +
    '.__ubLPConv:hover{background:var(--accent-soft);color:var(--text)}' +
    '.__ubLPConv.active{background:var(--accent-soft);color:var(--text)}' +
    '.__ubLPConvTitle{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.__ubLPSub{font-size:10.5px;color:var(--text-faint);flex-shrink:0}' +
    '.__ubLPStream{color:var(--accent);font-size:9px;animation:__ubLPblink 1.2s infinite;flex-shrink:0}' +
    '@keyframes __ubLPblink{50%{opacity:.25}}';
  if (!document.getElementById('__ubLPStyle')) {
    var stEl = document.createElement('style');
    stEl.id = '__ubLPStyle';
    stEl.textContent = css;
    document.head.appendChild(stEl);
  }

  // ── 生命周期 ──
  // React 重挂载 aside（视图切换等）会移除面板节点 → 观察器补插（S 状态保留）。
  // 与 layout.ts 同约定：观察器回调经 setTimeout 合并——同步 render 会因
  // 「补插节点 → 再次触发观察器」形成微任务饥饿（Electron 43 实测 renderer
  // 主线程卡死），合并后每拍最多一次，循环收敛。
  var renderTimer = null;
  new MutationObserver(function () {
    if (renderTimer !== null) return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      if (!document.getElementById('__ubLeftPanel')) render();
    }, 80);
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) connect(); });
  connect();
  render();
})();`;
}
