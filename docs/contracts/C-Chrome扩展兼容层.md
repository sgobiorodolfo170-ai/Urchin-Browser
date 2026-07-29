# 契约 C · M9 Chrome 扩展兼容层 API

> 状态：Draft  · 日期：2026-07-27  · 关联决策：D6 / CP1-CP7
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 设计目标

让 Chrome 扩展能零迁移跑在 Urchin 上（D6 决策），同时不开放危险能力，不让恶意扩展越权读取用户隐私数据。

这是「开发者友好」定位的实质内涵之一——扩展生态兼容性。

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│  Main Process                                                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Chrome Compat Backend                                 │    │
│  │  - chrome.tabs.* / chrome.storage.* / chrome.runtime.*│    │
│  │  - 实现 = 调用 M2(Tab) / M5(Bookmark) / M6(History)…  │    │
│  │  - 权限校验层（PermissionGuard 二次校验）              │    │
│  └──────────────────────────────────────────────────────┘    │
└────────────▲─────────────────────────────────────────────────┘
             │ ipcRenderer.invoke('chrome.<api>.<method>', args,
             │                  { extensionId, permissions })
┌────────────┴─────────────────────────────────────────────────┐
│  Extension WebContents (per-extension background page)        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Preload (contextIsolation: true, sandbox: true)       │    │  ← CP5
│  │  window.chrome = buildChromeApi({ extensionId, ... }) │    │
│  └──────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Extension Code (isolated world)                       │    │
│  │  - 调 chrome.tabs.query(...)                          │    │
│  │  - 不能直接访问 window, document, main world          │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

**CP2: per-extension 独立 webContents** — 每个扩展一个独立 Electron webContents（独立进程），crash 不影响其他扩展或主浏览器。代价是进程数随扩展数线性增长，但 v0.1 阶段扩展数量上限可控。

## 3. v0.1 实现的 chrome.* 子集

| API | v0.1 范围 | v0.2+ | 备注 |
|---|---|---|---|
| `chrome.tabs` | `query`/`get`/`create`/`update`/`remove`/`reload`/`onCreated`/`onUpdated`/`onRemoved` | 完整 | 浏览器扩展的最基础依赖 |
| `chrome.runtime` | `id`/`getURL`/`getManifest`/`onConnect`/`onMessage`/`sendMessage` | 完整 | 扩展自身生命周期与消息 |
| `chrome.storage.local` | `get`/`set`/`remove`/`clear`/`onChanged` | + sync | 扩展自己的持久化 |
| `chrome.windows` | `getCurrent`/`getAll`/`create`/`update`/`remove` | 完整 | 与 tabs 配套 |
| `chrome.notifications` | — | ✓ | v0.2 |
| `chrome.cookies` | — | ✓（需细权限） | 隐私敏感，推迟 |
| `chrome.history` | — | ✓ | v0.2 |
| `chrome.bookmarks` | — | ✓ | v0.2（与 M5 完整对接） |
| `chrome.webRequest` | — | ✓ | v0.2（隐私拦截依赖） |
| `chrome.declarativeNetRequest` | — | ✓ | v0.3+ |
| `chrome.identity` | — | ✓ | v0.2 |
| `chrome.scripting`/`executeScript` | 仅白名单域名（CP3 决策） | 用户审批 host_permissions | v0.1 限制注入范围 |

**子集选择原则**：v0.1 只放「不读不写用户隐私数据、不拦截网络」的最小子集；任何与 cookies/history/webRequest 相关的全部推迟。这是 D3「开发者友好」与「隐私底线」（见 [00-design-overview](../00-设计总览.md) §4）的平衡。

## 4. preload 暴露面（每个扩展独立 chrome 对象）

```typescript
// apps/desktop/src/preload/extension-preload.ts
import { ipcRenderer } from 'electron';
import type { chrome as ChromeNamespace } from '@urchin/chrome-types';

interface ExtContext {
  extensionId: string;
  permissions: string[];
  allowedHosts: string[];   // CP3: 白名单域名
}

const buildChromeApi = (ctx: ExtContext): typeof ChromeNamespace => {
  // 权限校验的包装器 — 第一道防线
  const requirePermission = (perm: string) => {
    if (!ctx.permissions.includes(perm)) {
      throw new Error(`Permission denied: ${perm}`);
    }
  };

  return {
    tabs: {
      query: (info: chrome.tabs.QueryInfo) => {
        requirePermission('tabs');
        return ipcRenderer.invoke('chrome.tabs.query', info, ctx);
      },
      create: (props: chrome.tabs.CreateProperties) => {
        requirePermission('tabs');
        return ipcRenderer.invoke('chrome.tabs.create', props, ctx);
      },
      get: (tabId: number) => ipcRenderer.invoke('chrome.tabs.get', { tabId }, ctx),
      update: (tabId: number, props: chrome.tabs.UpdateProperties) =>
        ipcRenderer.invoke('chrome.tabs.update', { tabId, props }, ctx),
      remove: (tabId: number) => ipcRenderer.invoke('chrome.tabs.remove', { tabId }, ctx),
      reload: (tabId: number) => ipcRenderer.invoke('chrome.tabs.reload', { tabId }, ctx),
      onCreated: { addListener: (cb: (tab: chrome.tabs.Tab) => void) => {
        ipcRenderer.on('chrome.tabs.onCreated', (_e, tab) => cb(tab));
      }},
      onUpdated: { addListener: (cb: (tabId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void) => {
        ipcRenderer.on('chrome.tabs.onUpdated', (_e, tabId, info, tab) => cb(tabId, info, tab));
      }},
      onRemoved: { addListener: (cb: (tabId: number, info: chrome.tabs.TabRemoveInfo) => void) => {
        ipcRenderer.on('chrome.tabs.onRemoved', (_e, tabId, info) => cb(tabId, info));
      }},
    },

    runtime: {
      id: ctx.extensionId,
      getURL: (path: string) => `urchin-extension://${ctx.extensionId}/${path}`,
      getManifest: () => ipcRenderer.invoke('chrome.runtime.getManifest', {}, ctx),
      sendMessage: (msg: any) => ipcRenderer.invoke('chrome.runtime.sendMessage', { msg }, ctx),
      onMessage: { addListener: (cb: (msg: any, sender: any) => void) => {
        ipcRenderer.on('chrome.runtime.onMessage', (_e, msg, sender) => cb(msg, sender));
      }},
    },

    storage: {
      local: {
        get: (keys?: string | string[] | null) =>
          ipcRenderer.invoke('chrome.storage.local.get', { keys }, ctx),
        set: (obj: object) =>
          ipcRenderer.invoke('chrome.storage.local.set', { obj }, ctx),
        remove: (keys: string | string[]) =>
          ipcRenderer.invoke('chrome.storage.local.remove', { keys }, ctx),
        clear: () => ipcRenderer.invoke('chrome.storage.local.clear', {}, ctx),
        onChanged: { addListener: (cb: (changes: any, areaName: string) => void) => {
          ipcRenderer.on('chrome.storage.local.onChanged', (_e, changes, areaName) => cb(changes, areaName));
        }},
      },
    },

    windows: {
      getCurrent: () => ipcRenderer.invoke('chrome.windows.getCurrent', {}, ctx),
      getAll: () => ipcRenderer.invoke('chrome.windows.getAll', {}, ctx),
      create: (props: chrome.windows.CreateData) =>
        ipcRenderer.invoke('chrome.windows.create', { props }, ctx),
      update: (windowId: number, props: chrome.windows.UpdateData) =>
        ipcRenderer.invoke('chrome.windows.update', { windowId, props }, ctx),
      remove: (windowId: number) => ipcRenderer.invoke('chrome.windows.remove', { windowId }, ctx),
    },

    scripting: {
      executeScript: async (target: chrome.scripting.ScriptInjection, func: () => any) => {
        // CP3 + CP6 决策：v0.1 仅允许 host_permissions 声明的白名单域名
        //（示意伪码：实际由 Backend 解析目标 tab 的 URL 并按 match pattern 匹配 allowedHosts）
        const allowed = await ipcRenderer.invoke('chrome.scripting.checkAllowed', { target }, ctx);
        if (!allowed) {
          throw new Error('Scripting not allowed for this target in v0.1');
        }
        return ipcRenderer.invoke('chrome.scripting.executeScript', { target, func }, ctx);
      },
    },
  } as unknown as typeof chrome;
};

// 暴露到 isolated world
const ctxJson = process.argv.find(a => a.startsWith('--urchin-ext='))!.slice('--urchin-ext='.length);
const ctx: ExtContext = JSON.parse(ctxJson);
(globalThis as any).chrome = buildChromeApi(ctx);
```

**关键设计**：
- `chrome` 对象在 preload 构造，每个扩展独立实例，带 extensionId + permissions。
- 权限校验在 **preload 第一道 + Backend 第二道**——纵深防御，恶意扩展绕过 preload 也会被 Backend 拦截。
- 扩展代码在 **isolated world**，无法直接访问页面 `window`/`document`，必须通过 `chrome.scripting.executeScript` 注入。

## 5. Backend 实现（main 进程）

```typescript
// apps/desktop/src/main/extensions/backend/tabs.ts
import { registerChromeHandler } from './router';

export function registerChromeTabsHandlers(): void {
  registerChromeHandler('chrome.tabs.query', ({ permissions }, info) => {
    if (!permissions.includes('tabs')) throw new ChromePermissionDenied('tabs');
    return tabManager.query(info);   // 直接调 M2 Tab Manager
  });

  registerChromeHandler('chrome.tabs.create', ({ permissions }, props) => {
    if (!permissions.includes('tabs')) throw new ChromePermissionDenied('tabs');
    return tabManager.create(props);
  });

  // ...
}
```

**关键设计**：Backend handler 直接调底层模块（M2/M5/M6 等）——chrome.* 兼容层是**适配层**不是重新实现。这避免「扩展 API」与「主浏览器 API」两套实现漂移。

**事件流（`onCreated` / `onUpdated`）**：Main 订阅 M2 的事件 → 转发到扩展 webContents（`webContents.send('chrome.tabs.onCreated', ...)`）→ preload 监听并调用扩展注册的 listener。

## 6. 权限模型

```typescript
// manifest 权限 → 实际 chrome.* 子 API 映射
const PERMISSION_TO_APIS: Record<string, string[]> = {
  'tabs':        ['chrome.tabs.*'],
  'storage':     ['chrome.storage.local.*'],
  'activeTab':   ['chrome.tabs.get(activeTabId)'],
  'scripting':   ['chrome.scripting.executeScript'],
  'notifications': ['chrome.notifications.*'],
  // ...
};

// 安装时校验 manifest.permissions，未知权限拒绝安装
function validateManifest(manifest: Manifest): ValidationResult {
  for (const perm of manifest.permissions ?? []) {
    if (!PERMISSION_TO_APIS[perm] && !perm.startsWith('http') && !perm.startsWith('https')) {
      return { valid: false, reason: `Unknown permission: ${perm}` };
    }
  }
  // CP6：v0.1 接受 host_permissions，但其唯一作用是 executeScript 白名单
  for (const host of manifest.host_permissions ?? []) {
    if (!isValidMatchPattern(host)) {
      return { valid: false, reason: `Invalid host match pattern: ${host}` };
    }
  }
  return { valid: true };
}
```

**CP6 决策（v0.1 host_permissions 语义）**：v0.1 接受 manifest 中的 `host_permissions` 字段，但它的**唯一**作用是作为 `chrome.scripting.executeScript` 的域名白名单（即 §4 `ctx.allowedHosts` 的来源）；其余依赖 host 权限的能力（`content_scripts` 自动注入、`webRequest`、按域读取 cookies 等）在 v0.1 一律不开放。安装 UI 需向用户展示「该扩展声明可注入脚本的域名清单」。

- v0.1：`host_permissions` = executeScript 白名单（CP3 + CP6）；白名单外目标一律拒。
- v0.2+ 引入完整 host permission 语义与逐域用户审批流程（弹窗确认，逐步放行）。

## 7. 前端契约：扩展 manifest 格式

v0.1 兼容 Chrome MV3 manifest 格式（CP1 决策），但忽略不支持的字段：

```json
{
  "manifest_version": 3,
  "name": "My Urchin Extension",
  "version": "1.0.0",
  "permissions": ["tabs", "storage"],
  "host_permissions": [],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html"
  }
}
```

- `background.service_worker` 在 Urchin 内模拟为：webContents 内的 Worker + `setInterval(() => {}, 1e6)` keepalive（CP1 决策，与 Chrome MV3 行为近似）。
- **CP7（SW 模拟保真度声明）**：v0.1 将 SW 模拟为**常驻 worker**，**不**模拟 Chrome MV3 SW 的「事件驱动 + 约 30s 空闲挂起 + 事件唤醒重建全局态」生命周期。依赖挂起/唤醒语义的扩展（如把状态放全局变量、期待唤醒时重建）行为可能不同——v0.2 评估真实 SW 生命周期模拟，届时更新兼容性说明。
- v0.1 不支持 `content_scripts`（注入页面 DOM）——待 v0.2 完整 host permission 语义（CP6）上线后配套开放。

## 8. 隔离与崩溃恢复

- **per-extension 独立 webContents**（CP2）→ 独立 process。
- 监听 `webContents.on('render-process-gone')` → 重启扩展 background page，最多 3 次。
- 超过 3 次 → 标记扩展禁用并通知用户，进入「禁用扩展」状态，需用户在 Settings 手动重启用。

## 9. 与 M10 Extension Loader 的关系

M10 分两级交付（与 [ADR-008](../decisions/ADR-008-v0.1范围与工期.md) 对齐）：

- **M10-lite（v0.1）**：解压扩展目录加载、manifest v3 解析与校验（§6 的 validateManifest 是其入口）、扩展生命周期管理（安装/卸载/启用/禁用）、沙箱。
- **M10 完整（v0.2）**：`.crx` 安装包支持、权限授予 UI 与撤销、扩展更新机制。

M9 仅提供 **API 兼容层**——扩展跑起来后能调用什么、不能调用什么。M9 是 M10 的运行时地基。

## 10. 未来演进

- v0.2: 完整 chrome.cookies/history/bookmarks/webRequest 子集，配套 host_permissions 审批 UI。
- v0.3: chrome.declarativeNetRequest（隐私过滤的现代化方案，替代 webRequest 阻塞式拦截）。
- v1.0: 双层 API——Chrome 兼容层 + Urchin 原生 API（更类型安全、AI 原生语义、与现代 Promise 化设计对齐）。鼓励新扩展用 Urchin 原生 API，旧扩展留 Chrome 兼容层过渡。
