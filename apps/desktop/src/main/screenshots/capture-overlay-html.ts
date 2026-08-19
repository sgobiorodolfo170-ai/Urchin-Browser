/**
 * 框选截图 · 覆盖窗口 HTML（urchin://capture-overlay）
 *
 * 全屏遮罩页：背景显示主进程缓存的整屏截图（desktopCapturer 原始分辨率），
 * 鼠标拖拽绘制选区（半透明蓝色框），绘制完成后选区继续支持交互：
 * 框内按住拖动移动整个选区，四边/四角按住拖动调整大小（悬停按位置切换指针）。
 * 选区右下角悬浮「取消」「确认」按钮，Esc 取消。确认时经
 * window.urchin.invoke('screenshot.confirm') 把选区逻辑坐标（CSS px，
 * 已含 devicePixelRatio 换算）回传主进程裁剪保存。
 *
 * 覆盖窗口为独立 BrowserWindow（transparent + alwaysOnTop），preload 在
 * urchin:// 协议下自动暴露 window.urchin.invoke（见 preload/index.ts）。
 */
export function getCaptureOverlayHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>框选截图</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
    body { position: relative; cursor: crosshair; user-select: none; }

    /* 背景：整屏截图铺满窗口（覆盖窗口 = 主显示器逻辑尺寸，截图物理像素 ÷ dpr 正好相等） */
    #screen {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      object-fit: fill;
    }

    /* 选区框（可交互：框内拖动移动，四边/四角拖动缩放，悬停指针由 JS 切换） */
    #selection {
      position: absolute; display: none;
      border: 1.5px solid #2563eb;
      background: rgba(37, 99, 235, 0.12);
      pointer-events: auto;
    }
    /* 选区外遮罩（四个区域） */
    .mask { position: absolute; background: rgba(0, 0, 0, 0.45); pointer-events: none; }
    #mask-top, #mask-bottom { left: 0; right: 0; }
    #mask-left, #mask-right { top: 0; bottom: 0; }

    /* 选区右下角正下方悬浮按钮（右缘与选区右缘对齐，垂直落在选区下方） */
    #actions {
      position: absolute; display: none; gap: 8px; align-items: center;
      transform: translate(-100%, 8px); pointer-events: auto; z-index: 10;
    }
    #actions button {
      border: none; border-radius: 6px; padding: 6px 16px;
      font-size: 13px; cursor: pointer; color: #fff;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    #cancel-btn { background: #64748b; }
    #cancel-btn:hover { background: #475569; }
    #confirm-btn { background: #2563eb; }
    #confirm-btn:hover { background: #1d4ed8; }

    #hint {
      position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%);
      color: #fff; background: rgba(0, 0, 0, 0.6); padding: 6px 14px;
      border-radius: 999px; font-size: 12px; pointer-events: none; z-index: 5;
    }
  </style>
</head>
<body>
  <img id="screen" alt="" draggable="false" />
  <div id="mask-top" class="mask"></div>
  <div id="mask-bottom" class="mask"></div>
  <div id="mask-left" class="mask"></div>
  <div id="mask-right" class="mask"></div>
  <div id="selection"></div>
  <div id="actions">
    <button id="cancel-btn">取消</button>
    <button id="confirm-btn">确认</button>
  </div>
  <div id="hint">拖拽选择区域 · 框内拖动移动 · 边框/四角缩放 · 框外右键取消 · Esc 取消</div>

  <script>
    (function () {
      // 背景截图：主进程桌面截图，直接铺满窗口显示
      window.urchin.invoke('screenshot.getImageData', {}).then(function (res) {
        document.getElementById('screen').src = res.dataUri;
      }).catch(function (e) {
        document.getElementById('hint').textContent = '加载截图失败：' + e.message;
      });

      var selection = document.getElementById('selection');
      var actions = document.getElementById('actions');
      var masks = {
        top: document.getElementById('mask-top'),
        bottom: document.getElementById('mask-bottom'),
        left: document.getElementById('mask-left'),
        right: document.getElementById('mask-right'),
      };
      var rect = null;
      // 交互状态机：null=空闲 / 'create'=拖拽新建 / 'move'=拖拽移动 / 'resize'=拖拽缩放
      var mode = null;
      var resizeDir = null;      // 'n','s','e','w' 或 'nw','ne','sw','se'
      var startX = 0, startY = 0; // create: 拖拽锚点
      var grabDX = 0, grabDY = 0; // move: 指针相对选区左上角的偏移

      // 命中区尺寸（CSS px）：四角优先命中，其次四边，最后框内（移动）
      var EDGE = 8;
      var CORNER = 12;
      // 选区最小尺寸（CSS px）：缩放钳制下限，防止拖过反向翻转
      var MIN_SIZE = 4;

      function clampX(v) { return Math.max(0, Math.min(v, window.innerWidth)); }
      function clampY(v) { return Math.max(0, Math.min(v, window.innerHeight)); }

      function updateMasks() {
        if (!rect) return;
        var top = rect.top, left = rect.left, right = rect.right, bottom = rect.bottom;
        masks.top.style.cssText = 'top:0;height:' + top + 'px;';
        masks.bottom.style.cssText = 'top:' + bottom + 'px;bottom:0;';
        masks.left.style.cssText = 'top:' + top + 'px;left:0;width:' + left + 'px;height:' + (bottom - top) + 'px;';
        masks.right.style.cssText = 'top:' + top + 'px;right:0;width:' + (window.innerWidth - right) + 'px;height:' + (bottom - top) + 'px;';
      }

      function renderSelection() {
        selection.style.cssText =
          'display:block;left:' + rect.left + 'px;top:' + rect.top + 'px;' +
          'width:' + (rect.right - rect.left) + 'px;height:' + (rect.bottom - rect.top) + 'px;';
        updateMasks();
      }

      // 命中检测：返回 { dir, cursor }（缩放方向或 'move'），框外返回 null
      function hitZone(x, y) {
        if (!rect) return null;
        var l = rect.left, t = rect.top, r = rect.right, b = rect.bottom;
        if (x >= l && x < l + CORNER && y >= t && y < t + CORNER) return { dir: 'nw', cursor: 'nwse-resize' };
        if (x > r - CORNER && x <= r && y >= t && y < t + CORNER) return { dir: 'ne', cursor: 'nesw-resize' };
        if (x >= l && x < l + CORNER && y > b - CORNER && y <= b) return { dir: 'sw', cursor: 'nesw-resize' };
        if (x > r - CORNER && x <= r && y > b - CORNER && y <= b) return { dir: 'se', cursor: 'nwse-resize' };
        if (x >= l && x <= r && y >= t && y < t + EDGE) return { dir: 'n', cursor: 'ns-resize' };
        if (x >= l && x <= r && y > b - EDGE && y <= b) return { dir: 's', cursor: 'ns-resize' };
        if (x >= l && x < l + EDGE && y > t + CORNER && y < b - CORNER) return { dir: 'w', cursor: 'ew-resize' };
        if (x > r - EDGE && x <= r && y > t + CORNER && y < b - CORNER) return { dir: 'e', cursor: 'ew-resize' };
        if (x > l && x < r && y > t && y < b) return { dir: 'move', cursor: 'move' };
        return null;
      }

      document.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        // 点按钮不开始拖拽
        if (e.target.closest('#actions')) return;

        // 指针在已有选区内：进入移动或缩放（角/边命中优先）
        if (rect && (e.target === selection || selection.contains(e.target))) {
          var zone = hitZone(e.clientX, e.clientY);
          if (zone) {
            startX = e.clientX; startY = e.clientY;
            if (zone.dir === 'move') {
              mode = 'move';
              grabDX = e.clientX - rect.left;
              grabDY = e.clientY - rect.top;
            } else {
              mode = 'resize';
              resizeDir = zone.dir;
            }
            actions.style.display = 'none';
            return;
          }
        }

        // 框外按下：新建选区（以按下点为拖拽锚点）
        mode = 'create';
        resizeDir = null;
        startX = e.clientX; startY = e.clientY;
        rect = { top: startY, left: startX, right: startX, bottom: startY };
        selection.style.display = 'block';
        selection.style.cursor = '';
        actions.style.display = 'none';
      });

      document.addEventListener('mousemove', function (e) {
        var x = clampX(e.clientX);
        var y = clampY(e.clientY);

        if (mode === 'create') {
          rect = {
            top: Math.min(startY, y), left: Math.min(startX, x),
            right: Math.max(startX, x), bottom: Math.max(startY, y),
          };
          renderSelection();
        } else if (mode === 'move') {
          // 保持宽高，跟随指针整体平移；钳制在视口内
          var w = rect.right - rect.left;
          var h = rect.bottom - rect.top;
          var left = Math.max(0, Math.min(x - grabDX, window.innerWidth - w));
          var top = Math.max(0, Math.min(y - grabDY, window.innerHeight - h));
          rect = { left: left, top: top, right: left + w, bottom: top + h };
          renderSelection();
        } else if (mode === 'resize') {
          // 按方向调整对应边；MIN_SIZE 钳制防止拖过反向翻转
          var r = rect;
          var nl = r.left, nt = r.top, nr = r.right, nb = r.bottom;
          if (resizeDir.indexOf('w') >= 0) nl = Math.max(0, Math.min(x, nr - MIN_SIZE));
          if (resizeDir.indexOf('e') >= 0) nr = Math.max(x, nl + MIN_SIZE);
          if (resizeDir.indexOf('n') >= 0) nt = Math.max(0, Math.min(y, nb - MIN_SIZE));
          if (resizeDir.indexOf('s') >= 0) nb = Math.max(y, nt + MIN_SIZE);
          rect = { left: nl, top: nt, right: nr, bottom: nb };
          renderSelection();
        } else {
          // 空闲悬停：按命中区切换指针样式，提示可移动/缩放
          var zone = hitZone(e.clientX, e.clientY);
          selection.style.cursor = zone ? zone.cursor : '';
        }
      });

      document.addEventListener('mouseup', function () {
        if (!mode) return;
        // 新建选区过小视为误操作，重置
        if (mode === 'create' && (rect.right - rect.left < MIN_SIZE || rect.bottom - rect.top < MIN_SIZE)) {
          rect = null;
          selection.style.display = 'none';
          actions.style.display = 'none';
          mode = null;
          return;
        }
        mode = null;
        resizeDir = null;
        // 按钮定位：选区右下角正下方（transform translate(-100%, 8px) 右缘对齐右缘、垂直下移 8px）
        actions.style.cssText =
          'display:flex;left:' + rect.right + 'px;top:' + rect.bottom + 'px;';
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          cancelCapture();
        }
      });
      // keyup 兜底：透明窗口焦点抖动时 keydown 可能被吞，keyup 再补一刀
      document.addEventListener('keyup', function (e) {
        if (e.key === 'Escape') {
          cancelCapture();
        }
      });

      // 右键框外取消（2026-08-19 新增）：选区框内右键保留默认（不取消），
      // 框外右键 = 取消截图动作。主进程另有 blur 兜底，双保险。
      document.addEventListener('contextmenu', function (e) {
        var inSelection =
          rect &&
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (inSelection) return; // 框内右键不取消
        e.preventDefault();
        cancelCapture();
      });

      function cancelCapture() {
        // preload 未注入时（理论上不会发生）静默兜底：提示而不是卡死
        if (!window.urchin || !window.urchin.invoke) {
          document.getElementById('hint').textContent = '按 Esc 取消';
          return;
        }
        window.urchin.invoke('screenshot.cancel', {}).catch(function () {});
      }

      document.getElementById('cancel-btn').addEventListener('click', function () {
        cancelCapture();
      });
      document.getElementById('confirm-btn').addEventListener('click', function () {
        if (!rect) return;
        var dpr = window.devicePixelRatio || 1;
        // 逻辑坐标 → 物理像素（裁剪用）后交主进程
        window.urchin.invoke('screenshot.confirm', {
          x: Math.round(rect.left * dpr),
          y: Math.round(rect.top * dpr),
          width: Math.round((rect.right - rect.left) * dpr),
          height: Math.round((rect.bottom - rect.top) * dpr),
        }).catch(function (e) {
          document.getElementById('hint').textContent = '保存失败：' + e.message;
        });
      });
    })();
  </script>
</body>
</html>`;
}
