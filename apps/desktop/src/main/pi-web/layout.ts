/**
 * pi 网页版 · 中区布局控制注入（dev.67 建立，dev.71 适配 0.47.0 原生拖拽把手）
 *
 * 用户需求：
 * 1. 中区左上角 / 右上角各一个折叠按钮——折叠/展开左区、右区。
 * 2. 中区与左右两区之间的分割线可自由拖动，位置持久化（项目关闭后下次
 *    打开仍是之前的位置）——经 urchin://pi-ui-state 主进程落盘（pi 端口
 *    随机，页面 localStorage 不可跨会话）。
 * 3. 右区「根目录」标题行遮挡下方提示窗——层叠修复：notice toast
 *    （.notices z-50）提到 70（高于窄屏抽屉 z-60）；[data-tip] 提示
 *    （z-40）提到 80，确保任何相邻内容都盖不住它。
 *
 * dev.71（0.47.0 适配）：上游原生提供 .resize-handle 拖拽把手（0.30.0 起），
 * 我方 dev.67 自绘分割线退役——**持久化挂到原生把手上**（原生拖拽 UX +
 * 我方落盘，pointerup 时读两区宽度写 ui-state）；宽度恢复仍由本脚本
 * applyAll 承担（原生宽度是 React 态，重载即失，我方落盘补跨会话）。
 * 折叠按钮无原生等价物，保留。
 *
 * 布局事实（0.47.0，桌面 >768px）：.panel-drawer{display:contents}——
 * 左区 aside.panel-left 与右区 aside.panel-right 是 .view-pane flex 行的
 * 静态项，.resize-handle 夹在中间；≤768px 原生把手 display:none（抽屉模式）。
 *
 * 与 left-panel.ts 的共享契约：本脚本先注入，暴露 window.__ubPiUI
 * {state:{lw,rw,lc,rc,po}, loaded, save(), __reorder()}；左区项目排序消费
 * state.po，状态就绪/排序变化时经 '__ubPiUIReady' / '__ubPiUIOrder' 事件
 * 通知其重渲染。
 */

/**
 * 构建中区布局控制注入脚本（纯字符串，可单测）。
 *
 * DOM 注入均为「只追加自有节点」：两个角标按钮进 main.main，两条分割线
 * 进 .view-pane（display:contents 的官方抽屉包装不参与布局，分割线与
 * 面板同处一个 flex 上下文）；React 重渲染移除后由 MutationObserver 补插。
 */
export function buildLayoutScript(): string {
  return `(function () {
  if (window.__ubLayoutInstalled) return;
  window.__ubLayoutInstalled = true;

  // ── 共享状态（left-panel.ts 消费 po；保存在 urchin://pi-ui-state）──
  var UI = {
    state: { lw: 240, rw: 240, lc: false, rc: false, po: [] },
    loaded: false,
  };
  window.__ubPiUI = UI;

  var saveTimer = null;
  UI.save = function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var s = UI.state;
      var q =
        '?a=set&lw=' + Math.round(s.lw) + '&rw=' + Math.round(s.rw) +
        '&lc=' + (s.lc ? 1 : 0) + '&rc=' + (s.rc ? 1 : 0) +
        '&po=' + encodeURIComponent(JSON.stringify(s.po || []));
      fetch('urchin://pi-ui-state' + q, { mode: 'cors' }).catch(function () {});
    }, 300);
  };

  // 项目排序重排（拖拽与自动化共用）：把 path 移到 beforePath 之前
  //（beforePath 为空 = 移到末尾），持久化并广播 '__ubPiUIOrder'
  UI.__reorder = function (path, beforePath) {
    var po = (UI.state.po || []).slice();
    var i = po.indexOf(path);
    if (i >= 0) po.splice(i, 1);
    if (beforePath) {
      var j = po.indexOf(beforePath);
      if (j < 0) { po.push(path); } else { po.splice(j, 0, path); }
    } else {
      po.push(path);
    }
    UI.state.po = po;
    UI.save();
    document.dispatchEvent(new CustomEvent('__ubPiUIOrder'));
  };

  fetch('urchin://pi-ui-state', { mode: 'cors' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || typeof d !== 'object') return;
      if (d.lw) UI.state.lw = d.lw;
      if (d.rw) UI.state.rw = d.rw;
      if (typeof d.lc === 'boolean') UI.state.lc = d.lc;
      if (typeof d.rc === 'boolean') UI.state.rc = d.rc;
      if (d.po instanceof Array) UI.state.po = d.po;
      UI.loaded = true;
      applyAll();
      document.dispatchEvent(new CustomEvent('__ubPiUIReady'));
    })
    .catch(function () { /* 读失败：默认值 + 不拦截左区渲染 */ });

  // ── 样式 ──
  var css =
    // main 需要定位上下文承载两枚角标按钮（原 .main 无 position）
    '.main{position:relative}' +
    '.__ubCornerBtn{position:absolute;top:10px;z-index:35;width:26px;height:26px;' +
    'display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);' +
    'border-radius:8px;background:color-mix(in srgb,var(--bg-elev) 88%,transparent);' +
    'color:var(--text-dim);font-size:14px;line-height:1;cursor:pointer;user-select:none}' +
    '.__ubCornerBtn:hover{background:var(--accent-soft);color:var(--accent)}' +
    '#__ubLTCollapse{left:8px}' +
    '#__ubRTCollapse{right:8px}' +
    // 折叠：官方抽屉包装 display:contents，隐藏包装即隐藏面板；原生把手随藏
    //（原生把手自带 resize-left/right 侧别类；后代选择器——.view-pane 非 html 直接子级）
    '.__ubNoLeft .drawer-left{display:none!important}' +
    '.__ubNoLeft .resize-handle.resize-left{display:none!important}' +
    '.__ubNoRight .drawer-right{display:none!important}' +
    '.__ubNoRight .resize-handle.resize-right{display:none!important}' +
    // dev.67 层叠修复：toast 提到抽屉之上；data-tip 提示提到 toast 之上
    '.notices{z-index:70!important}' +
    '[data-tip]:after{z-index:80!important}' +
    // 窄屏（≤768px 官方抽屉模式）：本组桌面控件整体隐藏，面板宽度交给官方
    '@media(max-width:768px){#__ubLTCollapse,#__ubRTCollapse{display:none!important}' +
    '.panel-left,.panel-right{width:auto!important}}';
  if (!document.getElementById('__ubLayoutStyle')) {
    var stEl = document.createElement('style');
    stEl.id = '__ubLayoutStyle';
    stEl.textContent = css;
    document.head.appendChild(stEl);
  }

  // ── DOM 注入（React 重渲染移除后由观察器补插）──
  function chatViewPane() {
    var panes = document.querySelectorAll('.layout > .view-pane');
    for (var i = 0; i < panes.length; i++) {
      if (panes[i].querySelector(':scope > main.main')) return panes[i];
    }
    return null;
  }

  function ensureDom() {
    var pane = chatViewPane();
    if (!pane) return;
    var main = pane.querySelector(':scope > main.main');
    if (!main) return;

    if (!document.getElementById('__ubLTCollapse')) {
      var bl = document.createElement('button');
      bl.type = 'button';
      bl.id = '__ubLTCollapse';
      bl.className = '__ubCornerBtn';
      bl.title = '折叠/展开左区';
      bl.addEventListener('click', function () {
        UI.state.lc = !UI.state.lc;
        applyAll();
        UI.save();
      });
      main.appendChild(bl);
    }
    if (!document.getElementById('__ubRTCollapse')) {
      var br = document.createElement('button');
      br.type = 'button';
      br.id = '__ubRTCollapse';
      br.className = '__ubCornerBtn';
      br.title = '折叠/展开右区';
      br.addEventListener('click', function () {
        UI.state.rc = !UI.state.rc;
        applyAll();
        UI.save();
      });
      main.appendChild(br);
    }
    // dev.71：原生 .resize-handle（自带 resize-left/right 类 + localStorage
    // 持久化——但 pi 端口随机致 localStorage 跨会话失效）挂持久化：pointerdown
    // 后在 window 上补一次 pointerup 读两区宽度落盘（拖拽中光标会离开把手，
    // 原生的 pointerup 派发在 window 而非把手，钩子必须同层才能收到）。
    // 读宽必须延后（~120ms）：pointerup 同步读的是 React 提交前的旧宽度，
    // 存进 UI.state 后会被 applyAll 用旧值把面板拽回去（实测复现）。
    // 跨重启保留是原生 localStorage 做不到的部分。
    // React 重建把手后由本函数重挂（__ubPersistHooked 防重复绑定）。
    var handles = pane.querySelectorAll(':scope > .resize-handle');
    for (var i = 0; i < handles.length; i++) {
      var h = handles[i];
      if (!h.__ubPersistHooked) {
        h.__ubPersistHooked = true;
        h.addEventListener('pointerdown', function () {
          var done = function () {
            window.removeEventListener('pointerup', done);
            setTimeout(function () {
              var pane2 = chatViewPane();
              if (!pane2) return;
              var left = pane2.querySelector('aside.panel-left');
              var right = pane2.querySelector('aside.panel-right');
              if (left) UI.state.lw = Math.round(left.getBoundingClientRect().width);
              if (right) UI.state.rw = Math.round(right.getBoundingClientRect().width);
              UI.save();
            }, 120);
          };
          window.addEventListener('pointerup', done);
        });
      }
    }
    applyAll();
  }

  // ── 应用状态到 DOM（宽度 + 折叠类 + 按钮方向）──
  function applyAll() {
    var pane = chatViewPane();
    var root = document.documentElement;
    root.classList.toggle('__ubNoLeft', !!UI.state.lc);
    root.classList.toggle('__ubNoRight', !!UI.state.rc);
    var bl = document.getElementById('__ubLTCollapse');
    if (bl) bl.textContent = UI.state.lc ? '\\u00bb' : '\\u00ab';
    var br = document.getElementById('__ubRTCollapse');
    if (br) br.textContent = UI.state.rc ? '\\u00ab' : '\\u00bb';
    if (!pane) return;
    // 宽度守护（dev.71）：0.47.0 原生用 .layout 上的 CSS 变量控宽
    // （--left-w/--right-w → .panel-left/right{width:var(...)}）——恢复/守护
    // 必须写变量而非 aside 内联宽度（内联会遮蔽变量，原生拖拽将失效，实测复现）。
    // 原生拖拽期间（body.panel-resizing）避让：React 是拖拽中的宽度作者，
    // 我方 pointerup 钩子（延迟读宽）会把最终宽度同步进 UI.state，之后一致。
    // 原生 React 重渲染会用它自己的 state（重载后为默认值）重写变量，我方
    // 不守护会弹回默认。
    var resizing = document.body.classList.contains('panel-resizing');
    if (resizing) return;
    var layout = pane.closest('.layout');
    if (!layout) return;
    if (!UI.state.lc) layout.style.setProperty('--left-w', Math.round(UI.state.lw) + 'px');
    if (!UI.state.rc) layout.style.setProperty('--right-w', Math.round(UI.state.rw) + 'px');
  }

  new MutationObserver(function () { ensureDom(); }).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  ensureDom();
})();`;
}
