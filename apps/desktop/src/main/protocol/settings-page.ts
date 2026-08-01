/**
 * urchin:// 内部协议 · 设置页
 *
 * 依据：02-架构设计 §4 安全边界 / 04-模块全景 M7
 * 职责：
 * 1. 提供 urchin://settings 页面的 HTML 内容
 * 2. 设置页通过 window.urchin.invoke('settings.*') 读写设置
 * 3. 设置项分组：外观（主题/语言）/ 通用（搜索引擎/主页/下载路径）/ 隐私（反追踪/DNT）/ AI 助手（模型/API Key）
 *
 * 设计理由：
 * - 设置页作为"网页形式"在 BrowserView 中加载，符合用户对"标签页式设置"的预期
 * - 通过 urchin:// 自定义协议加载，preload 在 urchin: 协议下暴露 urchin API
 * - HTML 内联样式，无外部依赖，加载快、打包简单
 * - 响应式布局，适配不同窗口尺寸
 */

/** 设置页 HTML 内容（单文件，无外部依赖） */
export function getSettingsPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>设置 · Urchin Browser</title>
  <style>
    :root {
      --bg: #ffffff;
      --bg-secondary: #f5f5f5;
      --border: #e5e5e5;
      --text: #1a1a1a;
      --text-secondary: #666666;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --danger: #dc2626;
      --success: #16a34a;
      --radius: 6px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1a1a1a;
        --bg-secondary: #262626;
        --border: #404040;
        --text: #f5f5f5;
        --text-secondary: #a3a3a3;
        --primary: #3b82f6;
        --primary-hover: #60a5fa;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      font-size: 14px;
    }
    .container {
      max-width: 760px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .subtitle {
      color: var(--text-secondary);
      font-size: 13px;
      margin-bottom: 32px;
    }
    section {
      margin-bottom: 32px;
    }
    section h2 {
      font-size: 16px;
      font-weight: 600;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 16px;
    }
    .field {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
      gap: 16px;
    }
    .field-label {
      flex: 1;
    }
    .field-label .name {
      font-weight: 500;
    }
    .field-label .desc {
      color: var(--text-secondary);
      font-size: 12px;
      margin-top: 2px;
    }
    .field-control {
      flex-shrink: 0;
      min-width: 240px;
    }
    select, input[type="text"], input[type="password"] {
      width: 100%;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
    }
    select:focus, input:focus {
      border-color: var(--primary);
    }
    .toggle {
      position: relative;
      width: 40px;
      height: 22px;
      background: var(--border);
      border-radius: 11px;
      cursor: pointer;
      transition: background 0.15s;
      flex-shrink: 0;
    }
    .toggle.on { background: var(--primary); }
    .toggle::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 18px;
      height: 18px;
      background: white;
      border-radius: 50%;
      transition: transform 0.15s;
    }
    .toggle.on::after { transform: translateX(18px); }
    .actions {
      position: sticky;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 12px 24px;
      background: var(--bg);
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin: 32px -24px -64px;
    }
    button {
      padding: 6px 16px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
    }
    button:hover { background: var(--bg-secondary); }
    button.primary {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
    }
    button.primary:hover { background: var(--primary-hover); }
    .toast {
      position: fixed;
      bottom: 64px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--success);
      color: white;
      padding: 8px 16px;
      border-radius: var(--radius);
      font-size: 13px;
      opacity: 0;
      transition: opacity 0.2s;
      pointer-events: none;
    }
    .toast.show { opacity: 1; }
    .loading {
      text-align: center;
      padding: 64px 0;
      color: var(--text-secondary);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>设置</h1>
    <p class="subtitle">Urchin Browser 偏好设置</p>

    <div id="content" class="loading">加载中…</div>

    <div class="actions">
      <button id="reset">重置默认</button>
      <button id="save" class="primary">保存</button>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    // 设置项定义（与 settings-manager DEFAULT_SETTINGS 对齐）
    const SETTING_GROUPS = [
      {
        title: '外观',
        fields: [
          { key: 'theme', label: '主题', desc: '浅色 / 深色', type: 'select', options: [
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
            { value: 'system', label: '跟随系统' },
          ]},
          { key: 'language', label: '界面语言', desc: '应用界面显示语言（默认中文）', type: 'select', options: [
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en-US', label: 'English' },
          ]},
        ],
      },
      {
        title: '通用',
        fields: [
          { key: 'searchEngine', label: '搜索引擎', desc: '地址栏搜索使用的引擎', type: 'select', options: [
            { value: 'google', label: 'Google' },
            { value: 'bing', label: 'Bing' },
            { value: 'baidu', label: '百度' },
            { value: 'duckduckgo', label: 'DuckDuckGo' },
          ]},
          { key: 'homepage', label: '主页', desc: '启动时打开的页面', type: 'text' },
          { key: 'downloadsPath', label: '下载位置', desc: '留空使用系统默认', type: 'directory' },
          { key: 'summary.saveDirectory', label: '摘要文档保存位置', desc: 'AI 摘要生成的网页文档保存目录（留空使用默认位置）', type: 'directory' },
          { key: 'links.openInNewTab', label: '在新标签页打开链接', desc: '点击网页内链接时在新标签页打开（关闭则在当前标签页打开）', type: 'toggle' },
        ],
      },
      {
        title: '隐私与安全',
        fields: [
          { key: 'blockTrackers', label: '拦截追踪器', desc: '阻止第三方追踪脚本', type: 'toggle' },
          { key: 'doNotTrack', label: '请勿追踪', desc: '发送 DNT 头', type: 'toggle' },
        ],
      },
      {
        title: 'AI 助手',
        fields: [
          { key: 'summary.providerId', label: '默认 Provider', desc: '摘要助手的服务提供方（留空使用首个可用 Provider）', type: 'provider-select' },
          { key: 'summary.model', label: '模型', desc: '摘要助手调用 LLM 时使用的模型名', type: 'text' },
          { key: 'summary.apiKey', label: 'API Key', desc: '摘要助手 Provider 鉴权密钥（加密存储）', type: 'password' },
          { key: 'summary.baseUrl', label: 'Base URL', desc: 'OpenAI 兼容协议端点（留空使用官方 https://api.openai.com）', type: 'text' },
        ],
      },
    ];

    const state = { entries: {}, original: {}, providers: [] };

    const contentEl = document.getElementById('content');
    const toastEl = document.getElementById('toast');

    function showToast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      setTimeout(() => toastEl.classList.remove('show'), 1800);
    }

    function renderForm() {
      let html = '';
      for (const group of SETTING_GROUPS) {
        html += '<section><h2>' + escapeHtml(group.title) + '</h2>';
        for (const f of group.fields) {
          const val = state.entries[f.key];
          html += '<div class="field"><div class="field-label">';
          html += '<div class="name">' + escapeHtml(f.label) + '</div>';
          if (f.desc) html += '<div class="desc">' + escapeHtml(f.desc) + '</div>';
          html += '</div><div class="field-control">';
          if (f.type === 'select') {
            html += '<select data-key="' + escapeHtml(f.key) + '">';
            for (const opt of f.options) {
              const sel = String(val) === opt.value ? ' selected' : '';
              html += '<option value="' + escapeHtml(opt.value) + '"' + sel + '>' + escapeHtml(opt.label) + '</option>';
            }
            html += '</select>';
          } else if (f.type === 'provider-select') {
            html += '<select data-key="' + escapeHtml(f.key) + '">';
            html += '<option value=""' + (!val ? ' selected' : '') + '>自动（使用首个可用 Provider）</option>';
            for (const p of state.providers) {
              const sel = String(val) === p.id ? ' selected' : '';
              html += '<option value="' + escapeHtml(p.id) + '"' + sel + '>' + escapeHtml(p.name + ' v' + p.version) + '</option>';
            }
            if (state.providers.length === 0) {
              html += '<option value="" disabled>（未安装任何 Provider）</option>';
            }
            html += '</select>';
          } else if (f.type === 'toggle') {
            const on = val === true;
            html += '<div class="toggle' + (on ? ' on' : '') + '" data-key="' + escapeHtml(f.key) + '" role="switch" tabindex="0"></div>';
          } else if (f.type === 'directory') {
            html += '<div class="directory-row" style="display:flex;gap:6px;align-items:center;">';
            html += '<input type="text" data-key="' + escapeHtml(f.key) + '" value="' + escapeHtml(String(val ?? '')) + '" placeholder="留空使用系统默认" style="flex:1;min-width:0;" />';
            html += '<button type="button" class="browse-btn" data-browse-key="' + escapeHtml(f.key) + '" data-browse-label="' + escapeHtml(f.label) + '" style="height:32px;padding:0 10px;white-space:nowrap;">浏览</button>';
            html += '</div>';
          } else {
            const type = f.type === 'password' ? 'password' : 'text';
            html += '<input type="' + type + '" data-key="' + escapeHtml(f.key) + '" value="' + escapeHtml(String(val ?? '')) + '" />';
          }
          html += '</div></div>';
        }
        html += '</section>';
      }
      contentEl.innerHTML = html;

      // 绑定事件
      contentEl.querySelectorAll('select, input').forEach(el => {
        el.addEventListener('change', () => {
          state.entries[el.dataset.key] = el.value;
        });
        el.addEventListener('input', () => {
          state.entries[el.dataset.key] = el.value;
        });
      });
      contentEl.querySelectorAll('.toggle').forEach(el => {
        const toggle = () => {
          const next = !el.classList.contains('on');
          el.classList.toggle('on', next);
          state.entries[el.dataset.key] = next;
        };
        el.addEventListener('click', toggle);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      });
      // 目录选择器「浏览」按钮：调用原生 dialog.selectDirectory IPC
      contentEl.querySelectorAll('.browse-btn').forEach(el => {
        el.addEventListener('click', async () => {
          const key = el.dataset.browseKey;
          const label = el.dataset.browseLabel || '选择目录';
          try {
            const result = await window.urchin.invoke('dialog.selectDirectory', { title: '选择' + label });
            if (result.path) {
              state.entries[key] = result.path;
              const input = contentEl.querySelector('input[data-key="' + CSS.escape(key) + '"]');
              if (input) input.value = result.path;
              showToast('已选择：' + result.path);
            }
          } catch (e) {
            showToast('选择目录失败：' + String(e));
          }
        });
      });
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    async function loadSettings() {
      try {
        const [settingsRes, providersRes] = await Promise.all([
          window.urchin.invoke('settings.getAll', {}),
          window.urchin.invoke('provider.list', {}).catch(() => ({ providers: [] })),
        ]);
        state.entries = {};
        for (const e of settingsRes.entries) state.entries[e.key] = e.value;
        state.original = JSON.parse(JSON.stringify(state.entries));
        state.providers = providersRes.providers || [];
        renderForm();
      } catch (e) {
        contentEl.innerHTML = '<p style="color: var(--danger)">加载失败：' + escapeHtml(String(e)) + '</p>';
      }
    }

    async function saveSettings() {
      try {
        for (const key of Object.keys(state.entries)) {
          if (JSON.stringify(state.entries[key]) !== JSON.stringify(state.original[key])) {
            await window.urchin.invoke('settings.set', { key, value: state.entries[key] });
          }
        }
        state.original = JSON.parse(JSON.stringify(state.entries));
        showToast('已保存');
      } catch (e) {
        showToast('保存失败：' + String(e));
      }
    }

    async function resetDefaults() {
      if (!confirm('确定重置所有设置为默认值？')) return;
      try {
        const defaults = {
          'theme': 'light', 'language': 'zh-CN', 'searchEngine': 'google',
          'homepage': 'urchin://newtab', 'downloadsPath': '',
          'blockTrackers': true, 'doNotTrack': true, 'links.openInNewTab': false,
          'summary.model': 'gpt-4o-mini', 'summary.apiKey': '', 'summary.providerId': '', 'summary.baseUrl': '',
        };
        for (const [k, v] of Object.entries(defaults)) {
          await window.urchin.invoke('settings.set', { key: k, value: v });
          state.entries[k] = v;
        }
        state.original = JSON.parse(JSON.stringify(state.entries));
        renderForm();
        showToast('已重置为默认值');
      } catch (e) {
        showToast('重置失败：' + String(e));
      }
    }

    document.getElementById('save').addEventListener('click', saveSettings);
    document.getElementById('reset').addEventListener('click', resetDefaults);

    loadSettings();
  </script>
</body>
</html>`;
}
