# 契约 G · M15 DevTools Enhancement

> 状态：Draft  · 日期：2026-07-27  · 关联决策：DT1-DT8
> 模块归属：renderer  · 关联模块：M2 / M11 / M12 / M13 / M17
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 设计目标

让浏览器**内置开发者工具增强**，无需装扩展即可获得：
- AI 辅助 console 解析（错误总结、修复建议）
- 网络请求摘要（API 调用统计、慢请求标记）
- 自定义 Panel——可挂自定义 React 组件展示任意数据
- 与 M13 Side Panel 联动（在 DevTools 里选中元素 → Side Panel 自动收到上下文）

这是「开发者友好」定位的产品形态核心。

## 2. 与 Chromium DevTools 的关系（DT1 决策）

Electron 内置 Chromium DevTools（`webContents.openDevTools()`），Urchin **不重写它**，而是**附加增强层**：

```
┌─────────────────────────────────────────────────────┐
│  Chromium DevTools (内置，原生)                      │
│  Elements / Console / Network / Sources / ...       │
└──────────────────┬──────────────────────────────────┘
                   │ webContents.debugger (CDP 协议)
                   ▼
┌─────────────────────────────────────────────────────┐
│  Urchin DevTools Enhancement Layer (附加)           │
│  ├─ Custom Panel Host (注册自定义 Panel)             │
│  ├─ CDP Event Bridge (订阅 Network/Console 事件)     │
│  ├─ AI Analyzer (调 M11 做摘要/修复建议)             │
│  └─ Side Panel Linkage (与 M13 联动)                │
└─────────────────────────────────────────────────────┘
```

**DT1 决策落地**：v0.1 选 **A. CDP 客户端 + 自研 React 面板**，独立 BrowserView 分屏显示。否决理由：
- B. DevTools Extension：Electron 对 DevTools Extension 支持不完整，打包复杂。
- C. Overlay 注入：影响目标页面渲染，不专业。

## 3. CDP（Chrome DevTools Protocol）接入

```typescript
// apps/desktop/src/renderer/devtools-enhance/cdp-client.ts
import type { WebContents } from 'electron';

export class CdpClient {
  constructor(private wc: WebContents) {}

  async attach(): Promise<void> {
    await this.wc.debugger.attach('1.3');   // DT3 决策：CDP 版本 1.3
  }

  async detach(): Promise<void> {
    await this.wc.debugger.detach();
  }

  async enableNetwork(): Promise<void> {
    await this.wc.debugger.sendCommand('Network.enable');
  }

  async enableConsole(): Promise<void> {
    await this.wc.debugger.sendCommand('Runtime.enable');
    await this.wc.debugger.sendCommand('Log.enable');
  }

  /** 订阅所有 CDP 事件 */
  on(event: string, cb: (params: any) => void): void {
    this.wc.debugger.on('message', (_e, method: string, params: any) => {
      if (method === event) cb(params);
    });
  }
}
```

## 4. 网络请求摘要（v0.1 demo）

```typescript
// apps/desktop/src/renderer/devtools-enhance/network-tracker.ts
interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  size?: number;
  durationMs?: number;
  startedAt: number;
}

async function trackNetwork(cdp: CdpClient): Promise<void> {
  await cdp.enableNetwork();

  const entries = new Map<string, NetworkEntry>();

  cdp.on('Network.requestWillBeSent', (p) => {
    entries.set(p.requestId, {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      startedAt: Date.now(),
    });
  });

  cdp.on('Network.responseReceived', (p) => {
    const e = entries.get(p.requestId);
    if (e) {
      e.status = p.response.status;
      e.mimeType = p.response.mimeType;
    }
  });

  cdp.on('Network.loadingFinished', (p) => {
    const e = entries.get(p.requestId);
    if (e) {
      e.size = p.encodedDataLength;
      e.durationMs = Date.now() - e.startedAt;
      networkStore.upsert(e);   // DT7 决策：节流 batch
    }
  });
}
```

### AI 摘要：选中慢请求 / 错误请求右键「AI 分析」

```typescript
async function analyzeWithAI(entry: NetworkEntry): Promise<void> {
  // DT6 决策：复用 M11 Orchestrator + Provider 流式 Port
  const port = await invoke('ai.chat.start', {
    providerId: getActiveProviderId(),
    conversationId: genId(),
    messages: [{
      role: 'user',
      content: `分析这个网络请求：${entry.method} ${entry.url} → ${entry.status} (${entry.durationMs}ms, ${entry.size} bytes)。可能的原因与建议？`,
    }],
    stream: true,
  });
  // 复用 M13 流式渲染管线
  subscribeToStream(port);
}
```

## 5. AI 辅助 console 解析（v0.1 demo）

```typescript
// apps/desktop/src/renderer/devtools-enhance/console-tracker.ts
async function trackConsole(cdp: CdpClient): Promise<void> {
  await cdp.enableConsole();

  cdp.on('Runtime.exceptionThrown', (p) => {
    const details = p.exceptionDetails;
    consoleStore.add({
      type: 'error',
      text: details.text ?? JSON.stringify(details.exception),
      source: 'exception',
      stackTrace: details.stackTrace?.callFrames,
    });
  });

  cdp.on('Log.entryAdded', (p) => {
    consoleStore.add({
      type: p.entry.level,
      text: p.entry.text,
      source: p.entry.source,
      stackTrace: p.entry.stackTrace?.callFrames,
    });
  });
}

// 批量「AI 总结所有错误」按钮
async function summarizeErrors(): Promise<void> {
  const errors = consoleStore.getErrors();
  if (errors.length === 0) return;

  const port = await invoke('ai.chat.start', {
    providerId: getActiveProviderId(),
    conversationId: genId(),
    messages: [{
      role: 'user',
      content: `页面存在 ${errors.length} 个错误：\n${errors.map(e => `- ${e.text}`).join('\n')}\n\n总结根本原因与建议修复路径。`,
    }],
    stream: true,
  });
  subscribeToStream(port);
}
```

## 6. 自定义 Panel 注册（DT4 决策：v0.1 仅内部）

```typescript
// M15 未在 v0.1 实现，此文件仅为占位契约
export interface DevToolsPanelManifest {
  id: string;                        // 'panel-network-summary'
  title: string;                     // 显示在 tab 标题
  icon?: string;                     // SVG/dataurl
  /** 渲染入口——React 组件 */
  component: React.ComponentType<PanelProps>;
  /** 调用的 CDP 能力白名单 */
  cdpCapabilities: string[];          // ['Network', 'Runtime', 'Log']
}

export interface PanelProps {
  webContentsId: number;              // 被检视的 tab
  cdp: CdpClient;                     // 已 attach 的 CDP 客户端
  aiInvoke: (prompt: string) => Promise<StreamPort>;  // 调 AI 的便捷方法
}

// 注册 API（v0.1 仅内部用，v0.2+ 开放给扩展）
export function registerDevToolsPanel(manifest: DevToolsPanelManifest): void {
  devtoolsPanelRegistry.register(manifest);
}
```

**DT4 决策落地**：v0.1 仅内部使用，v0.2+ 开放给扩展。理由：v0.1 开放不会有生态（用户量小），先内部稳定接口再开放。

## 7. 与 M13 Side Panel 联动（DT5 决策）

```typescript
// 在 DevTools 面板「右键 → 发送到 Side Panel」
// DevTools Enhancement 是独立 BrowserView（DT2），与主窗口 Renderer 不同进程，通信走两跳：
// 第一跳：RPC 到 Main（契约 B §3 'sidepanel.inject_context'）
async function sendToSidePanel(content: string): Promise<void> {
  await invoke('sidepanel.inject_context', { content, source: 'devtools' });
}

// 第二跳：Main 转发为单向事件推送到主窗口 Renderer（契约 B §7 'sidepanel.context_injected'）
ipcRenderer.on('sidepanel.context_injected', (_e, { content, source }) => {
  useAIConversation.getState().appendSystemContext({ source, content });
});
```

**DT5 决策落地**：v0.1 demo 实现「右键发到 Side Panel」单向联动；v0.2+ 引入双向（Side Panel 反向选中 DevTools 元素）。

## 8. UI 形态（DT2 决策）

```
┌───────────────────────────────┬────────────────────────────┐
│  目标页面                      │  Urchin DevTools Enhance   │
│  (被检视的 tab)                │  ┌─[Network]─[Console]─┐   │
│                               │  │ Tab 切换              │   │
│                               │  ├──────────────────────┤   │
│                               │  │ 列表 + 详情视图       │   │
│                               │  │ [AI 总结] [AI 修复]   │   │
│                               │  └──────────────────────┘   │
└───────────────────────────────┴────────────────────────────┘
                                │ Side Panel (M13)
                                ▼
                       ┌──────────────────────┐
                       │  AI 对话             │
                       └──────────────────────┘
```

**DT2 决策落地**：主窗口的独立 BrowserView 分屏。否决理由：
- 独立 BrowserWindow 窗口管理复杂。
- 嵌入原生 DevTools 受限于 Chromium DevToolsFrontend。

## 9. 性能策略（DT7 决策）

CDP 事件高频（每秒可能几十次），需节流 + 环形缓冲：

- 网络/控制台事件 200ms batch 进 Zustand store（避免高频 re-render）。
- Ring Buffer 保留最近 1000 条，超出 FIFO 淘汰（避免爆内存）。
- 详情视图按需展开，不一次性渲染所有 entries。

```typescript
class RingBuffer<T> {
  constructor(private capacity: number = 1000) {}
  private items: T[] = [];
  private head = 0;

  push(item: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(item);
    } else {
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  toArray(): T[] {
    return [...this.items.slice(this.head), ...this.items.slice(0, this.head)];
  }
}

const networkBuffer = new RingBuffer<NetworkEntry>(1000);
const flushTicker = setInterval(() => {
  if (networkBuffer.size === 0) return;
  networkStore.replaceAll(networkBuffer.toArray());
}, 200);
```

## 10. 启动方式（DT8 决策）

- 命令面板（Ctrl+Shift+P）输入「Toggle DevTools Enhancement」
- 快捷键 F12（与 Chromium DevTools 习惯一致；v0.1 内置 Chromium DevTools 仍可通过 Ctrl+Shift+I 打开，F12 触发 Urchin Enhancement）

## 11. 决策记录

| ID | 决策 | 选定方案 | 否决方案理由 |
|---|---|---|---|
| DT1 | v0.1 集成形态 | A. CDP 客户端 + 自研 React 面板 | B DevTools Extension Electron 支持不完整；C Overlay 注入不专业 |
| DT2 | DevTools Enhancement 渲染位置 | 主窗口的独立 BrowserView 分屏 | 独立 BrowserWindow 窗口管理复杂；嵌入原生 DevTools 受限 |
| DT3 | CDP 版本 | '1.3'（成熟稳定） | '1.2' 或更低，能力受限 |
| DT4 | 自定义 Panel 注册开放时机 | v0.1 仅内部；v0.2+ 开放给扩展 | v0.1 就开放但生态空，意义不大 |
| DT5 | 与 Side Panel 联动 | v0.1 demo：「右键发到 Side Panel」单向 | v0.1 直接做双向复杂度高 |
| DT6 | AI 调用通道 | 复用 M11 Orchestrator + Provider 流式 Port | 独立「devtools-only Provider」破坏 Provider 中立 |
| DT7 | 性能：CDP 事件高频 | 节流 200ms batch + Ring Buffer 1000 条 | 实时 setState 卡；全量保留爆内存 |
| DT8 | 启动方式 | 命令面板（Ctrl+Shift+P）+ 快捷键 F12 | 仅快捷键不够发现性；仅菜单不够便捷 |

## 12. 未来演进

- v0.2: 自定义 Panel API 开放给扩展；与 Side Panel 双向联动；DOM 元素检视增强
- v0.3: 性能瀑布图（基于 CDP Tracing）；Har 导出
- v0.5: 多 tab 同时检视（currently 是单 tab）；UMD/Source Map 增强
- v1.0: 内置 AI 调试助手——自动检测页面异常并主动建议修复路径（无需用户手动点 AI 总结）
