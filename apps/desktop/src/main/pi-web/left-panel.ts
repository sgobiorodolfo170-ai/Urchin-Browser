/**
 * pi 网页版 · 左区重构注入（dev.65）
 *
 * 用户需求（改变左区项目管理设定，仍分上下两区）：
 * - 上区（原「最近项目」）→ 「项目配置」：管理 pi 项目的技能、插件、.pi/ 配置文件
 *   （MCP 等项目级配置的实际载体即 `<项目>/.pi/` 目录；pi 栈自身无 MCP 一等概念，
 *   故以通用配置文件编辑覆盖）。技能/插件启停走官方 set_settings 通道。
 * - 下区（原「历史对话」）→ 「项目」管理区：每个项目一行（点击切换 = 原最近项目的
 *   管理全部移入），行内「＋」在对应项目下新建对话；当前项目自动展开，下挂其
 *   「对话」（运行中）与「历史」（会话文件）——历史对话放入对应项目名下管理。
 *
 * 数据通道（关键设计）：注入脚本以 sessionStorage 的官方 clientId（pi-web-client-id）
 * 建立第二条 WebSocket——服务端 attach(clientId) 复用同一 ClientSession 并把新 socket
 * 加入广播集（emit 广播到所有 sink），因此：
 * - 收：projects / conversations / sessions / settings_state / files / file_content /
 *   snapshot（cwd）全部广播；
 * - 发：set_cwd / new_chat / switch_conversation / switch_session / set_settings /
 *   list_files / read_file / write_file 与官方 UI 同源（同一 ClientSession），
 *   状态变化经官方 UI 自己的 socket 回流，React 自动刷新。
 *
 * 优雅降级：自有面板拿到首个 cwd 前不加 __ubReady 类，官方面板保持可见
 * （:has() CSS 控制），官方 dev.45-48 增强（删除按钮/新对话移植）保留作降级路径。
 *
 * 约束与取舍（不动第三方包源码原则不变）：
 * - 会话列表协议只提供「当前项目」的 sessions/conversations（服务端按 cwd 过滤），
 *   故非当前项目不展开子列表——展开即切换（官方数据模型语义）。
 * - 「＋」跨项目新建 = set_cwd 后等 snapshot 确认 cwd 已切换再发 new_chat
 *  （两条消息直发会交错：服务端 dispatch 不 await setCwd，new_chat 会落在旧 cwd）。
 * - list_files('.pi') 会重置服务端文件监视目录（单目录 watch），故惰性加载：
 *   用户展开「配置文件」小节才请求，避免干扰官方文件面板的实时刷新。
 * - write_file 仅允许改已存在文件（服务端限制），配置文件行仅列现存文件。
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
    cwd: '', settings: null, piFiles: null, piListed: false,
    openCfg: '', pendNew: '', pendNewAt: 0, editor: null,
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
      if (S.piListed) send({ type: 'list_files', path: '.pi' });
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
    if (m.type === 'projects') { S.projects = m.projects || []; render(); }
    else if (m.type === 'conversations') { S.conversations = m.conversations || []; S.activeId = m.activeId; render(); }
    else if (m.type === 'sessions') { S.sessions = m.sessions || []; render(); }
    else if (m.type === 'settings_state') { S.settings = m.settings || null; render(); }
    else if (m.type === 'files') {
      if ((m.path || '') === '.pi') { S.piFiles = m.entries || []; render(); }
    } else if (m.type === 'file_content') {
      if ((m.path || '').indexOf('.pi/') === 0 && S.editor && S.editor.path === m.path) updateEditor(m);
    } else if (m.type === 'snapshot') {
      // 流式期间快照 flood（~60ms/次）只做廉价 cwd 比对，无变化不重渲染
      var cwd = m.state && m.state.cwd;
      if (cwd && cwd !== S.cwd) {
        S.cwd = cwd;
        send({ type: 'list_projects' });
        send({ type: 'list_sessions' });
        if (S.piListed) send({ type: 'list_files', path: '.pi' });
        // 跨项目「＋」：cwd 已切换到目标 → 补发 new_chat（避免落在旧 cwd）
        if (S.pendNew && S.pendNew === cwd) { S.pendNew = ''; send({ type: 'new_chat' }); }
        render();
      }
    }
  }

  // 跨项目新建兜底：8s 内 snapshot 未确认即放弃（服务端会另行弹错误 notice）
  setInterval(function () {
    if (S.pendNew && Date.now() - S.pendNewAt > 8000) S.pendNew = '';
  }, 2000);

  // ── 会话内隐藏项目（与 dev.45/47 官方行删除同一存储语义）──
  function hiddenList() {
    try { return JSON.parse(sessionStorage.getItem('__ubHiddenProjects') || '[]'); } catch (e) { return []; }
  }
  function saveHidden(l) {
    try { sessionStorage.setItem('__ubHiddenProjects', JSON.stringify(l)); } catch (e) {}
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

  // ── 面板根节点（一次性创建 + 一次性事件委托）──
  function zoneEl() {
    var aside = document.querySelector('.panel.panel-left');
    if (!aside) return null;
    var z = document.getElementById('__ubLeftPanel');
    if (!z) {
      z = document.createElement('div');
      z.id = '__ubLeftPanel';
      z.className = '__ubLP';
      aside.insertBefore(z, aside.firstChild);
      z.addEventListener('click', onAction);
    }
    return z;
  }

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
    // 优雅降级：未拿到 cwd（ws 未就绪/失败）不接管，官方面板保持可见
    if (!S.cwd && !S.projects.length) { z.classList.remove('__ubReady'); z.innerHTML = ''; return; }
    z.classList.add('__ubReady');

    var hidden = hiddenList();
    var projects = S.projects.filter(function (p) { return hidden.indexOf(p.path) < 0; });
    var st = S.settings || {};
    var skills = st.skills || [], exts = st.extensions || [];
    var piFiles = (S.piFiles || []).filter(function (f) { return f.type === 'file'; });

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
    h += cfgRow('files', '配置文件 .pi/', S.piListed ? (S.piFiles ? piFiles.length + ' 个' : '…') : '展开查看');
    if (S.openCfg === 'files') {
      if (S.piFiles && piFiles.length) {
        h += '<div class="__ubLPItemList">';
        piFiles.forEach(function (f) {
          h += '<button type="button" class="__ubLPFile" data-act="file" data-v="' + esc(f.path) + '" title="' + esc(f.path) + '">' + esc(f.name) + '</button>';
        });
        h += '</div>';
      } else if (S.piFiles) {
        h += emptyHint('无 .pi 配置目录（项目级技能 / 命令 / mcp 等配置可放这里）');
      } else {
        h += emptyHint('加载中…');
      }
    }
    h += '</div>';

    // ── 下区：项目管理 ──
    h += '<div class="__ubLPProjs"><div class="panel-section-title">项目</div><div class="__ubLPScroll">';
    if (!projects.length) h += emptyHint('暂无项目');
    projects.forEach(function (p) {
      var act = p.path === S.cwd;
      h += '<div class="__ubLPProjWrap' + (act ? ' active' : '') + '">';
      h += '<button type="button" class="__ubLPProj' + (act ? ' active' : '') + '" data-act="proj" data-v="' + esc(p.path) + '" title="' + esc(p.path) + '">' +
        '<span class="__ubLPChev">' + (act ? '▾' : '▸') + '</span>' +
        '<span class="__ubLPProjName">' + esc(baseName(p.path)) + '</span>' +
        '<span class="__ubLPTime">' + esc(fmtTime(p.lastUsed)) + '</span>' +
        '<span class="__ubNewBtn" data-act="newchat" data-v="' + esc(p.path) + '" title="新建对话">＋</span>' +
        '<span class="__ubProjDel" data-act="del" data-v="' + esc(p.path) + '" title="从列表移除该项目">×</span>' +
        '</button>';
      if (act) {
        h += '<div class="__ubLPConvGroup"><div class="__ubLPMini">对话</div>';
        if (!S.conversations.length) h += '<div class="__ubLPHint" style="padding:2px 8px 6px">（无运行中对话）</div>';
        S.conversations.forEach(function (c) {
          h += '<button type="button" class="__ubLPConv' + (c.id === S.activeId ? ' active' : '') + '" data-act="conv" data-v="' + esc(String(c.id)) + '" title="' + esc(c.title || '') + '">' +
            '<span class="__ubLPConvTitle">' + esc(c.title || '新对话') + '</span>' +
            (c.isStreaming
              ? '<span class="__ubLPStream" title="生成中">●</span>'
              : '<span class="__ubLPSub">' + (c.messageCount || 0) + ' 条</span>') +
            '</button>';
        });
        h += '</div>';
        h += '<div class="__ubLPConvGroup"><div class="__ubLPMini">历史</div>';
        if (!S.sessions.length) h += '<div class="__ubLPHint" style="padding:2px 8px 6px">（无历史会话）</div>';
        S.sessions.slice(0, 50).forEach(function (ss) {
          h += '<button type="button" class="__ubLPConv __ubLPSess" data-act="sess" data-v="' + esc(ss.path) + '" title="' + esc(ss.path) + '">' +
            '<span class="__ubLPConvTitle">' + esc(ss.name || ss.firstMessage || '未命名会话') + '</span>' +
            '<span class="__ubLPSub">' + esc(fmtTime(ss.modified)) + '</span>' +
            '</button>';
        });
        h += '</div>';
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
    } else if (act === 'del') {
      var ok = (typeof window.__ubProjDelConfirm === 'function')
        ? window.__ubProjDelConfirm(v)
        : window.confirm('确认从最近项目列表移除？\\n' + v);
      if (!ok) return;
      var l = hiddenList();
      if (v && l.indexOf(v) < 0) { l.push(v); saveHidden(l); }
      render();
    } else if (act === 'conv') {
      if (v !== String(S.activeId)) send({ type: 'switch_conversation', id: Number(v) });
    } else if (act === 'sess') {
      send({ type: 'switch_session', path: v });
    } else if (act === 'skill') {
      send({ type: 'set_settings', disabledSkills: toggleArr((S.settings && S.settings.disabledSkills) || [], v) });
    } else if (act === 'ext') {
      send({ type: 'set_settings', disabledExtensions: toggleArr((S.settings && S.settings.disabledExtensions) || [], v) });
    } else if (act === 'cfg') {
      S.openCfg = S.openCfg === v ? '' : v;
      // 惰性加载 .pi 目录：list_files 会重置服务端单目录文件监视
      if (S.openCfg === 'files' && !S.piListed) { S.piListed = true; send({ type: 'list_files', path: '.pi' }); }
      render();
    } else if (act === 'file') {
      openEditor(v);
      send({ type: 'read_file', path: v });
    }
  }

  // ── .pi 配置文件编辑器（body 级浮层，render 重建不波及）──
  function edBox() {
    var d = document.getElementById('__ubLPEditor');
    if (!d) {
      d = document.createElement('div');
      d.id = '__ubLPEditor';
      d.innerHTML =
        '<div class="__ubLPEdBox">' +
        '<div class="__ubLPEdHead"><span class="__ubLPEdPath"></span><span class="__ubLPEdStatus"></span>' +
        '<button type="button" class="__ubLPEdBtn" data-eact="cancel">关闭</button>' +
        '<button type="button" class="__ubLPEdBtn primary" data-eact="save">保存</button></div>' +
        '<textarea class="__ubLPEdText" spellcheck="false"></textarea>' +
        '</div>';
      document.body.appendChild(d);
      d.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-eact]') : null;
        if (!b) return;
        if (b.getAttribute('data-eact') === 'cancel') closeEditor();
        else if (S.editor) send({ type: 'write_file', path: S.editor.path, text: d.querySelector('.__ubLPEdText').value });
      });
      d.addEventListener('mousedown', function (ev) { if (ev.target === d) closeEditor(); });
    }
    return d;
  }
  function openEditor(path) {
    S.editor = { path: path, binary: false };
    var d = edBox();
    d.querySelector('.__ubLPEdPath').textContent = path;
    d.querySelector('.__ubLPEdStatus').textContent = '加载中…';
    d.querySelector('.__ubLPEdText').value = '';
  }
  function updateEditor(m) {
    S.editor.binary = !!m.binary;
    var d = edBox();
    var ta = d.querySelector('.__ubLPEdText');
    // 用户正在编辑时不覆盖内容（保存后服务端会回推 file_content）
    if (document.activeElement !== ta) ta.value = m.binary ? '' : (m.text || '');
    ta.disabled = !!m.binary;
    d.querySelector('.__ubLPEdStatus').textContent = m.binary ? '二进制文件，不支持编辑' : (m.truncated ? '内容过大已截断（不建议保存）' : '已加载');
  }
  function closeEditor() {
    S.editor = null;
    var d = document.getElementById('__ubLPEditor');
    if (d) d.remove();
  }

  // ── 样式（一次性注入）──
  var css =
    '.__ubLP{flex:1;min-height:0;display:flex;flex-direction:column;width:100%}' +
    // 优雅降级：面板就绪（拿到 cwd）才隐藏官方三区，ws 失败时官方行为完整保留
    '.panel-left:has(>.__ubLP.__ubReady)>.panel-projects,' +
    '.panel-left:has(>.__ubLP.__ubReady)>.panel-convs,' +
    '.panel-left:has(>.__ubLP.__ubReady)>.panel-sessions{display:none!important}' +
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
    '.__ubLPFile{display:flex;width:100%;padding:5px 8px;border:none;border-radius:0 8px 8px 0;background:transparent;color:var(--text-dim);font-size:12px;text-align:left;cursor:pointer}' +
    '.__ubLPFile:hover{background:var(--accent-soft);color:var(--text)}' +
    '.__ubLPHint{padding:4px 10px 8px;color:var(--text-faint);font-size:11.5px}' +
    '.__ubLPProjs{flex:1;min-height:0;display:flex;flex-direction:column;padding:0 6px}' +
    '.__ubLPScroll{flex:1;overflow-y:auto;min-height:0;padding-bottom:56px}' +
    '.__ubLPProjWrap{margin-bottom:2px}' +
    '.__ubLPProj{display:flex;align-items:center;gap:6px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:var(--text-dim);font-size:12.5px;text-align:left;cursor:pointer}' +
    '.__ubLPProj:hover{background:var(--accent-soft)}' +
    '.__ubLPProj.active{background:var(--accent-soft);color:var(--text);border:1px solid rgba(139,92,246,.3);padding:6px 9px}' +
    '.__ubLPProjName{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.__ubLPTime{font-size:10.5px;color:var(--text-faint);flex-shrink:0}' +
    '.__ubNewBtn{width:20px;height:20px;line-height:18px;text-align:center;border-radius:5px;color:var(--text-dim);flex-shrink:0;font-size:13px}' +
    '.__ubNewBtn:hover{background:var(--accent);color:#fff}' +
    // __ubProjDel 与官方行内删除共用类名（E2E 钩子），此处覆盖官方绝对定位
    '.__ubLPProj .__ubProjDel{position:static;opacity:.65;margin-left:2px}' +
    '.__ubLPProj:hover .__ubProjDel{opacity:1}' +
    '.__ubLPConvGroup{margin:0 0 6px 14px;border-left:2px solid var(--border);padding-left:4px}' +
    '.__ubLPMini{padding:4px 8px 2px;font-size:10px;font-weight:700;letter-spacing:.5px;color:var(--text-faint);text-transform:uppercase}' +
    '.__ubLPConv{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:none;border-radius:0 8px 8px 0;background:transparent;color:var(--text-dim);font-size:12px;text-align:left;cursor:pointer;margin-bottom:1px}' +
    '.__ubLPConv:hover{background:var(--accent-soft);color:var(--text)}' +
    '.__ubLPConv.active{background:var(--accent-soft);color:var(--text)}' +
    '.__ubLPConvTitle{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.__ubLPSub{font-size:10.5px;color:var(--text-faint);flex-shrink:0}' +
    '.__ubLPStream{color:var(--accent);font-size:9px;animation:__ubLPblink 1.2s infinite;flex-shrink:0}' +
    '@keyframes __ubLPblink{50%{opacity:.25}}' +
    '#__ubLPEditor{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:120;display:flex;align-items:center;justify-content:center}' +
    '.__ubLPEdBox{width:min(720px,90vw);height:min(520px,80vh);background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.4)}' +
    '.__ubLPEdHead{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);font-size:12.5px;color:var(--text)}' +
    '.__ubLPEdPath{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}' +
    '.__ubLPEdStatus{font-size:11px;color:var(--text-faint);flex-shrink:0}' +
    '.__ubLPEdBtn{padding:4px 12px;border-radius:7px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:12px;cursor:pointer;flex-shrink:0}' +
    '.__ubLPEdBtn.primary{background:var(--accent);border-color:var(--accent);color:#fff}' +
    '.__ubLPEdText{flex:1;border:none;outline:none;resize:none;background:var(--bg);color:var(--text);font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;padding:12px}';
  if (!document.getElementById('__ubLPStyle')) {
    var stEl = document.createElement('style');
    stEl.id = '__ubLPStyle';
    stEl.textContent = css;
    document.head.appendChild(stEl);
  }

  // ── 生命周期 ──
  // React 重挂载 aside（视图切换等）会移除面板节点 → 观察器补插（S 状态保留）
  new MutationObserver(function () {
    if (!document.getElementById('__ubLeftPanel')) render();
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) connect(); });
  connect();
  render();
})();`;
}
