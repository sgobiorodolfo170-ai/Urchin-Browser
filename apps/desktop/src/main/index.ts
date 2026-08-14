/**
 * Urchin Browser · 主进程入口
 *
 * 依据：02-架构设计 §1 进程模型 / §6 启动顺序 / 04-模块全景 M1/M2/M17/M18
 * 职责（v0.1 W1-D3）：
 * 1. 初始化 WindowManager（M1 Window Lifecycle）
 * 2. 初始化 TabManager（M2 Tab Manager）
 * 3. 创建主窗口（M18 sandbox + contextIsolation + preload）
 * 4. 注册 IPC handlers（M17 tab + window 域）
 * 5. 应用生命周期事件（单实例锁 / activate / window-all-closed）
 *
 * 后续 wave 在此基础上叠加 M3/M5-M10/M23 完整实现。
 */
// Polyfill 必须在所有其他模块之前加载：undici 顶层 require node:worker_threads
// 并解构 markAsUncloneable（Node 22.3+ 才有），Electron 32/Node 20 缺失会导致启动崩溃。
import './polyfills/worker-threads-polyfill';
import { app, ipcMain, dialog, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createLogger } from '@urchin/logger';

import { PROVIDER_EVENT_CHANNEL, registerHandler, type ProviderEvent } from '@urchin/ipc-contract';
import { WindowManager, createBrowserWindow, registerWindowHandlers } from './windows';
import {
  TabManager,
  createBrowserView,
  registerTabHandlers,
  installTabViewIntegration,
  setLayoutState,
  type TabViewIntegrationHandle,
} from './tabs';
import { HistoryManager, registerHistoryHandlers, type HistoryPersistence } from './history';
import { BookmarkManager, registerBookmarkHandlers, type BookmarkPersistence } from './bookmarks';
import { SettingsManager, registerSettingsHandlers } from './settings';
import { DownloadManager, registerDownloadHandlers } from './downloads';
import { registerAiHandlers } from './ai';
import { registerAiInputHandlers } from './ai/input-handlers';
import type { ProviderConfigStore } from './ai';
import { registerPageContextHandlers } from './page-context';
import { SummaryManager, registerSummaryHandlers } from './summary';
import { Orchestrator } from './orchestrator/orchestrator';
import { ProviderRegistry } from './orchestrator/provider-registry';
import { electronProcessFactory } from './orchestrator/electron-factory';
import { StorageLayer, createSqliteDatabase, ElectronSafeStorage } from './storage';
import { registerUrchinSchemePrivileged, registerUrchinProtocol } from './protocol';

const log = createLogger('main');

/** 书签表行结构（SQLite 存储格式，snake_case） */
interface BookmarkRow {
  id: string;
  parent_id: string | null;
  url: string | null;
  title: string;
  type: string;
  position: number;
  created_at: number;
  updated_at: number;
}

/** 历史记录表行结构（SQLite 存储格式，snake_case） */
interface HistoryRow {
  id: number;
  url: string;
  title: string | null;
  visited_at: number;
  visit_count: number;
}

// E2E 测试隔离：若指定 URCHIN_TEST_USER_DATA，覆盖 userData 路径，确保每次测试使用全新 SQLite 数据库
// 必须在 any app.getPath('userData') 调用前执行
if (process.env.URCHIN_TEST_USER_DATA) {
  app.setPath('userData', process.env.URCHIN_TEST_USER_DATA);
}

// 注册 urchin: scheme 为特权协议（必须在 app ready 之前）
registerUrchinSchemePrivileged();

// 单例锁：防止多实例打开（02-架构设计 §1.2）
// E2E 测试环境（PLAYWRIGHT）跳过单实例锁，避免与 Playwright loader 冲突
if (!process.env.PLAYWRIGHT) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  }
}

/**
 * 全局 WindowManager 实例（M1）。
 *
 * 设计理由（agents.md §七.2）：
 * 单例管理所有窗口，保证 windowId 分配的全局唯一性。
 * 通过工厂函数注入，使核心逻辑可测试。
 */
const windowManager = new WindowManager(createBrowserWindow);

/**
 * 全局 TabManager 实例（M2）。
 *
 * 设计理由（契约 D §2 / agents.md §七.2）：
 * 单例管理所有 tab，保证 tabId 分配的全局唯一性。
 * 主进程是 Single Source of Truth，渲染层 store 只是镜像。
 * 通过工厂函数注入，使核心逻辑可测试。
 */
const tabManager = new TabManager(createBrowserView);

/**
 * 全局 HistoryManager 实例（M6）。
 * 在 app.whenReady() 中初始化，注入 StorageLayer 持久化。
 * 启动时从 SQLite 加载已有历史记录，变更时同步写入。
 */
let historyManager!: HistoryManager;

/**
 * 全局 BookmarkManager 实例（M5）。
 * 在 app.whenReady() 中初始化，注入 StorageLayer 持久化。
 * 启动时从 SQLite 加载已有书签，变更时同步写入。
 */
let bookmarkManager!: BookmarkManager;

/**
 * 全局 SettingsManager 实例（M7）。
 * 在 app.whenReady() 中初始化，注入 StorageLayer 持久化。
 */
let settingsManager!: SettingsManager;

/**
 * 全局 SummaryManager 实例（摘要文档本地存储）。
 * 在 app.whenReady() 中初始化，保存目录来自 summary.saveDirectory 设置。
 */
let summaryManager!: SummaryManager;

/**
 * 全局 DownloadManager 实例（M23）。
 * v0.1 W2 基础实现：下载项状态管理 + 进度跟踪。
 */
const downloadManager = new DownloadManager();

/**
 * Provider 注册表（M11）：扫描 %APPDATA%/Urchin/providers/ 目录。
 * 在 app.whenReady() 内初始化，避免模块加载阶段触碰文件系统。
 */
let providerRegistry!: ProviderRegistry;
let orchestrator!: Orchestrator;
let providerConfigStore!: ProviderConfigStore;
let tabViewIntegration: TabViewIntegrationHandle | null = null;
/**
 * AI IPC handlers 的 dispose 句柄（由 registerAiHandlers 返回）。
 * 进程退出时调用 dispose()，abort 所有活跃 chat/agent 流，
 * 间接触发 stream.ts / pi-event-bridge.ts 的 cleanup()，
 * 释放 listener、MessagePort 和 HTTP 连接。
 */
let aiHandlersDispose: (() => void) | null = null;
/**
 * 全局 StorageLayer 引用（在 whenReady 中赋值）。
 * 退出时需调用 close() 以释放 better-sqlite3 原生句柄，
 * 避免进程退出后残留线程或 WAL 文件未 checkpoint。
 */
let storageLayer: StorageLayer | null = null;

/**
 * 退出清理标志位：避免 before-quit 与 window-all-closed / SIGINT 重复执行清理。
 * 第一次进入清理流程时置为 true，后续直接退出。
 */
let isCleaningUp = false;

/**
 * 清理完成标志位：异步清理完成后置为 true，
 * 使 before-quit 重入时不再 preventDefault，允许进程真正退出。
 */
let cleanupDone = false;

/**
 * 向所有窗口的渲染进程广播 Provider 事件（W5-D4）。
 *
 * crash 事件需要推送到 UI 显示 warning banner，
 * 状态变更用于刷新 Provider 列表状态。
 */
function broadcastProviderEvent(event: ProviderEvent): void {
  const windows = windowManager.getAllWindows();
  for (const win of windows) {
    try {
      win.browserWindow.webContents.send(PROVIDER_EVENT_CHANNEL, event);
    } catch (err) {
      log.warn('failed to broadcast provider event', {
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * 注册 IPC handlers。
 * W1-D3：tab 域完整实现 + window 域完整实现。
 */
function registerIpcHandlers(): void {
  // M1 window 域 handler
  registerWindowHandlers(ipcMain, windowManager);

  // M2 tab 域 handler
  registerTabHandlers(ipcMain, tabManager);

  // M6 history 域 handler
  registerHistoryHandlers(ipcMain, historyManager);

  // M5 bookmark 域 handler
  registerBookmarkHandlers(ipcMain, bookmarkManager);

  // M7 settings 域 handler
  registerSettingsHandlers(ipcMain, settingsManager);

  // M23 download 域 handler
  registerDownloadHandlers(ipcMain, downloadManager);

  // dialog 域 handler：原生目录选择器
  // 供设置页「下载位置」「摘要文档保存位置」等路径字段点击选择目录使用。
  registerHandler(ipcMain, 'dialog.selectDirectory', async (req) => {
    const focused = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(focused!, {
      title: req.title ?? '选择目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { path: null };
    }
    return { path: result.filePaths[0]! };
  });

  // M13 AI 域 handler（provider.list/install/remove/config + ai.chat.start/abort + ai.agent.start/abort）
  // agentConfigProvider 复用 settingsManager + providerConfigStore 的合并逻辑，为 pi 适配层提供 apiKey/baseUrl
  // 注意：providerConfigStore.get 返回 Promise（aiStore.get 是 async），必须 await
  const agentConfigProvider = {
    async get(providerId: string): Promise<{ apiKey?: string; baseUrl?: string }> {
      // 等待敏感键预加载完成，确保 ai.apiKey 已从 secretStore 读入内存
      await settingsManager.ensureSecretsLoaded();
      const perProvider = providerConfigStore ? await providerConfigStore.get(providerId) : null;
      const cfg =
        typeof perProvider === 'object' && perProvider !== null
          ? (perProvider as Record<string, unknown>)
          : {};
      const globalApiKey = settingsManager.get('ai.apiKey');
      const globalBaseUrl = settingsManager.get('ai.baseUrl');
      return {
        apiKey:
          typeof cfg.apiKey === 'string'
            ? cfg.apiKey
            : typeof globalApiKey === 'string'
              ? globalApiKey
              : undefined,
        baseUrl:
          typeof cfg.baseUrl === 'string'
            ? cfg.baseUrl
            : typeof globalBaseUrl === 'string'
              ? globalBaseUrl
              : undefined,
      };
    },
  };
  // 保存 AI handlers 的 dispose 句柄，退出时用于 abort 活跃流
  const aiHandlers = registerAiHandlers(
    ipcMain,
    orchestrator,
    providerRegistry,
    providerConfigStore,
    agentConfigProvider,
  );
  aiHandlersDispose = () => aiHandlers.dispose();

  // pi 模块前端加号菜单三项：截图、上传文件、设置工作目录
  registerAiInputHandlers(ipcMain);

  // M14 page context 域 handler（page.extract）
  registerPageContextHandlers(ipcMain, tabManager);

  // Summary 域 handler（摘要 Agent · 与 pi 模块隔离）
  registerSummaryHandlers({
    ipcMain,
    summaryManager,
    tabManager,
    windowManager,
  });

  // UI 域 handler：布局状态切换（左/右侧栏宽度 + 下侧栏高度 + 内容区可见性）
  registerHandler(ipcMain, 'ui.layout.setState', (req) => {
    const newState = setLayoutState({
      leftWidth: req.leftWidth,
      rightWidth: req.rightWidth,
      bottomHeight: req.bottomHeight,
      contentHidden: req.contentHidden,
      browserViewHidden: req.browserViewHidden,
    });
    // 立即刷新所有窗口的 BrowserView bounds
    tabViewIntegration?.refreshAllViewBounds();
    log.info('layout state updated', {
      leftWidth: newState.leftWidth,
      rightWidth: newState.rightWidth,
      bottomHeight: newState.bottomHeight,
      contentHidden: newState.contentHidden,
      browserViewHidden: newState.browserViewHidden,
    });
    return {
      leftWidth: newState.leftWidth,
      rightWidth: newState.rightWidth,
      bottomHeight: newState.bottomHeight,
      contentHidden: newState.contentHidden,
      browserViewHidden: newState.browserViewHidden,
    };
  });

  log.info('ipc handlers registered');
}

/**
 * 确保内置 Provider 已部署到 userData/providers 目录。
 *
 * 内置 OpenAI 兼容 Provider 支持 OpenAI / Azure OpenAI / Ollama / vLLM 等
 * 兼容 /v1/chat/completions 端点的服务。通过 config.baseUrl 自定义端点。
 *
 * 如果 provider 目录已存在则跳过（不覆盖用户修改）。
 */
function ensureBuiltinProviders(providersDir: string): void {
  // OpenAI 兼容 Provider
  const openaiDir = join(providersDir, 'openai-compatible');
  const openaiManifest = join(openaiDir, 'manifest.json');
  if (!existsSync(openaiManifest)) {
    mkdirSync(openaiDir, { recursive: true });
    writeFileSync(
      join(openaiDir, 'manifest.json'),
      JSON.stringify(
        {
          id: 'openai-compatible',
          name: 'OpenAI Compatible',
          version: '1.0.0',
          apiVersion: 'urchin-ai-provider/v1',
          capabilities: ['chat.completion', 'chat.completion.streaming'],
          authMethod: 'api_key',
          rateLimit: { requestsPerMin: 60 },
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(join(openaiDir, 'index.js'), OPENAI_COMPATIBLE_PROVIDER_CODE, 'utf-8');
    log.info('built-in openai-compatible provider deployed', { dir: openaiDir });
  }
}

/**
 * OpenAI 兼容 Provider 子进程代码。
 *
 * 通过 config.baseUrl + config.apiKey 调用 /v1/chat/completions 端点，
 * 支持流式（SSE）和非流式响应。兼容 OpenAI / Azure OpenAI / Ollama / vLLM 等。
 */
const OPENAI_COMPATIBLE_PROVIDER_CODE = `'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

let orchPort = null;
let heartbeatTimer;

const manifest = {
  id: 'openai-compatible',
  name: 'OpenAI Compatible',
  version: '1.0.0',
  apiVersion: 'urchin-ai-provider/v1',
  capabilities: ['chat.completion', 'chat.completion.streaming'],
  authMethod: 'api_key',
  rateLimit: { requestsPerMin: 60 },
};

// Provider 配置（从 init 消息接收）
let providerConfig = {};

process.parentPort.on('message', (event) => {
  const data = event.data;
  if (!data || data.kind !== 'orch.init') return;
  orchPort = event.ports[0];
  orchPort.on('message', (msg) => {
    handleMessage(msg).catch((err) => {
      console.error('[openai-compatible] handler error', err);
    });
  });
  orchPort.start();
});

async function handleMessage(raw) {
  const msg = raw;
  if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;
  switch (msg.kind) {
    case 'init':
      providerConfig = (msg.config && typeof msg.config === 'object') ? msg.config : {};
      send({ kind: 'ready', manifest });
      startHeartbeat();
      console.log('[openai-compatible] ready, providerId=' + msg.providerId);
      break;
    case 'stream':
      await handleStream(msg);
      break;
    case 'complete':
      await handleComplete(msg);
      break;
    case 'abort':
      console.log('[openai-compatible] abort received, conv=' + msg.conversationId);
      break;
    case 'dispose':
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (orchPort && typeof orchPort.close === 'function') orchPort.close();
      process.exit(0);
      break;
  }
}

/** 获取 API 端点 URL */
function getEndpoint(path) {
  const baseUrl = (providerConfig.baseUrl || 'https://api.openai.com').replace(/\\/$/, '');
  return baseUrl + path;
}

/** 获取 API Key */
function getApiKey() {
  return providerConfig.apiKey || '';
}

/** 构建请求头 */
function getHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const key = getApiKey();
  if (key) headers['Authorization'] = 'Bearer ' + key;
  return headers;
}

/** 发送 HTTPS/HTTP 请求 */
function request(options) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'POST',
      headers: options.headers || getHeaders(),
    };
    const req = lib.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + body));
        } else {
          resolve({ statusCode: res.statusCode, body, res });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** 发送流式请求并解析 SSE */
async function requestStream(options, onChunk) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: options.headers || getHeaders(),
    };
    const req = lib.request(reqOptions, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let errBody = '';
        res.on('data', (c) => { errBody += c; });
        res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ': ' + errBody)));
        return;
      }
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') { resolve(); return; }
          try {
            const parsed = JSON.parse(data);
            onChunk(parsed);
          } catch (e) {
            // 忽略解析错误
          }
        }
      });
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** 处理流式请求 */
async function handleStream(msg) {
  const conversationId = msg.conversationId;
  const req = msg.req;
  const model = req.model || providerConfig.model || 'gpt-4o-mini';
  const body = JSON.stringify({
    model,
    messages: req.messages,
    stream: true,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
  });

  try {
    await requestStream({
      url: getEndpoint('/v1/chat/completions'),
      body,
    }, (parsed) => {
      const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
      if (delta && delta.content) {
        send({ kind: 'stream.chunk', conversationId, chunk: { content: delta.content } });
      }
    });
    send({ kind: 'stream.end', conversationId, finishReason: 'stop' });
  } catch (err) {
    send({ kind: 'error', conversationId, error: { message: String(err.message || err), code: 'PROVIDER_ERROR' } });
  }
}

/** 处理非流式请求 */
async function handleComplete(msg) {
  const conversationId = msg.conversationId;
  const req = msg.req;
  const model = req.model || providerConfig.model || 'gpt-4o-mini';
  const body = JSON.stringify({
    model,
    messages: req.messages,
    stream: false,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
  });

  try {
    const result = await request({ url: getEndpoint('/v1/chat/completions'), body });
    const parsed = JSON.parse(result.body);
    const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content || '';
    send({
      kind: 'complete.response',
      conversationId,
      response: { content, role: 'assistant', finishReason: 'stop' },
    });
  } catch (err) {
    send({ kind: 'error', conversationId, error: { message: String(err.message || err), code: 'PROVIDER_ERROR' } });
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    send({ kind: 'heartbeat', timestamp: Date.now(), stats: { activeStreams: 0, totalRequests: 0 } });
  }, 5000);
}

function send(msg) {
  if (!orchPort) return;
  try { orchPort.postMessage(msg); } catch (err) { console.error('[openai-compatible] postMessage failed', err); }
}
`;

// 应用就绪
void app.whenReady().then(() => {
  // 注册 urchin:// 协议处理器（必须在 app ready 之后）
  registerUrchinProtocol();

  // 初始化需要文件系统 / SQLite 的模块（W6：移入 whenReady 避免模块加载阶段崩溃）
  const userDataPath = app.getPath('userData');
  const providersDir = join(userDataPath, 'providers');
  providerRegistry = new ProviderRegistry(providersDir);

  const dataDir = join(userDataPath, 'data');
  const sl = new StorageLayer(dataDir, new ElectronSafeStorage(), createSqliteDatabase);
  storageLayer = sl;

  // 初始化 SettingsManager，注入 StorageLayer 持久化（设置变更自动写入 SQLite）。
  // 注入 sl.secrets（safeStorage 加密存储）：ai.apiKey / summary.apiKey 走加密落盘，不存明文。
  settingsManager = new SettingsManager(sl.mainStore, sl.secrets);

  // 初始化 BookmarkManager，注入 SQLite 持久化适配器。
  // 启动时从 bookmarks 表加载已有书签到内存，create/delete 时同步写入 SQLite。
  // 修复：此前 BookmarkManager 仅用内存 Map，软件重启后书签全部丢失。
  const bookmarkPersistence: BookmarkPersistence = {
    loadAll(): ReturnType<BookmarkPersistence['loadAll']> {
      const rows = sl.mainStore.query<BookmarkRow>(
        'SELECT id, parent_id, url, title, type, position, created_at, updated_at FROM bookmarks',
      );
      return rows.map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        url: row.url ?? undefined,
        title: row.title,
        type: row.type as 'bookmark' | 'folder',
        position: row.position,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
    upsert(bookmark): void {
      sl.mainStore.run(
        'INSERT INTO bookmarks (id, parent_id, url, title, type, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, url = excluded.url, title = excluded.title, type = excluded.type, position = excluded.position, updated_at = excluded.updated_at',
        bookmark.id,
        bookmark.parentId,
        bookmark.url ?? null,
        bookmark.title,
        bookmark.type,
        bookmark.position,
        bookmark.createdAt,
        bookmark.updatedAt,
      );
    },
    remove(id): void {
      sl.mainStore.run('DELETE FROM bookmarks WHERE id = ?', id);
    },
  };
  bookmarkManager = new BookmarkManager(bookmarkPersistence);

  // 初始化 HistoryManager，注入 SQLite 持久化适配器。
  // 启动时从 history 表加载已有记录到内存，record/delete/clear 时同步写入 SQLite。
  // 修复：此前 HistoryManager 仅用内存 Map，软件重启后历史记录全部丢失。
  const historyPersistence: HistoryPersistence = {
    loadAll(): ReturnType<HistoryPersistence['loadAll']> {
      const rows = sl.mainStore.query<HistoryRow>(
        'SELECT id, url, title, visited_at, visit_count FROM history',
      );
      return rows.map((row) => ({
        id: row.id,
        url: row.url,
        title: row.title ?? '',
        visitedAt: row.visited_at,
        visitCount: row.visit_count,
      }));
    },
    upsert(entry): void {
      sl.mainStore.run(
        'INSERT INTO history (id, url, title, visited_at, visit_count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, visited_at = excluded.visited_at, visit_count = excluded.visit_count',
        entry.id,
        entry.url,
        entry.title,
        entry.visitedAt,
        entry.visitCount,
      );
    },
    remove(id): void {
      sl.mainStore.run('DELETE FROM history WHERE id = ?', id);
    },
    clearAll(): void {
      sl.mainStore.run('DELETE FROM history');
    },
  };
  historyManager = new HistoryManager(historyPersistence);

  // 初始化 SummaryManager（摘要文档本地存储），同步用户配置的保存目录
  summaryManager = new SummaryManager(userDataPath);
  summaryManager.setSaveDirectory(
    settingsManager.get('summary.saveDirectory') as string | undefined,
  );
  // 监听保存目录设置变更，实时同步到 SummaryManager
  settingsManager.on('changed', (key, value) => {
    if (key === 'summary.saveDirectory') {
      summaryManager.setSaveDirectory(value as string | undefined);
    }
  });

  providerConfigStore = {
    get(providerId: string): unknown {
      return sl.aiStore.get<unknown>(`provider_config:${providerId}`);
    },
    set(providerId: string, config: unknown): void {
      sl.aiStore.set(`provider_config:${providerId}`, config);
    },
  };

  /**
   * 配置提供器：合并 per-provider 配置与全局 AI 设置（apiKey / baseUrl / model）。
   *
   * 全局设置（ai.apiKey / ai.baseUrl / ai.model）通过 SettingsManager 读取，
   * 合并到 provider config 中，使 OpenAI 兼容 Provider 能直接使用设置页配置的密钥和端点。
   * per-provider 配置（provider_config:<id>）优先级高于全局设置，允许覆盖。
   *
   * 注意：providerConfigStore.get 返回 Promise（aiStore.get 是 async），必须 await。
   * 若不 await，Promise 对象被展开会把 then/catch/finally 函数注入 config，
   * 经 port.postMessage 结构化克隆会抛 "An object could not be cloned"。
   */
  const mergedConfigProvider = async (providerId: string): Promise<unknown> => {
    // 等待敏感键预加载完成，确保 ai.apiKey 已从 secretStore 读入内存
    await settingsManager.ensureSecretsLoaded();
    const perProvider = await providerConfigStore.get(providerId);
    const globalApiKey = settingsManager.get('ai.apiKey');
    const globalBaseUrl = settingsManager.get('ai.baseUrl');
    const globalModel = settingsManager.get('ai.model');
    const merged: Record<string, unknown> = {
      ...(typeof perProvider === 'object' && perProvider !== null
        ? (perProvider as Record<string, unknown>)
        : {}),
    };
    // 全局设置作为默认值，per-provider 配置可覆盖
    if (typeof globalApiKey === 'string' && globalApiKey && merged.apiKey === undefined) {
      merged.apiKey = globalApiKey;
    }
    if (typeof globalBaseUrl === 'string' && globalBaseUrl && merged.baseUrl === undefined) {
      merged.baseUrl = globalBaseUrl;
    }
    if (typeof globalModel === 'string' && globalModel && merged.model === undefined) {
      merged.model = globalModel;
    }
    return merged;
  };

  orchestrator = new Orchestrator({
    registry: providerRegistry,
    processFactory: electronProcessFactory,
    configProvider: mergedConfigProvider,
    events: {
      onProviderStateChanged: (providerId, state) => {
        broadcastProviderEvent({
          type: 'state-changed',
          providerId,
          state,
        });
      },
      onProviderCrashed: (providerId, reason) => {
        broadcastProviderEvent({ type: 'crashed', providerId, reason });
      },
    },
  });

  registerIpcHandlers();

  // 注入链接打开行为解析器：根据设置决定点击链接时在当前/新标签页打开
  // 设置 links.openInNewTab = true 时新标签页打开，否则当前标签页打开（默认）
  tabManager.setLinkBehaviorResolver(() => {
    const openInNewTab = settingsManager.get('links.openInNewTab') === true;
    return openInNewTab ? 'new-tab' : 'current';
  });

  // 监听 tab 导航事件，自动记录浏览历史。
  //
  // 根因：history.record IPC handler 存在但从未被调用，导致历史记录始终为空。
  // 修复：监听 TabManager 的 'updated' 事件，当页面加载完成（loading=false）
  // 且 URL 为 http/https 时记录到 historyManager。
  // 通过 lastUrlPerTab 去重，避免同一 URL 因 title 更新等事件被重复记录。
  const lastUrlPerTab = new Map<number, string>();
  tabManager.on('updated', (snapshot) => {
    // 等待页面加载完成后再记录（此时 URL 和 title 都已确定）
    if (snapshot.loading) return;
    const url = snapshot.url;
    // 仅记录 http/https URL（排除 about:blank / urchin:// 等内部页面）
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    // 去重：同一 tab 的同一 URL 只记录一次（后续重复访问由 historyManager.record 内部递增 visitCount）
    if (lastUrlPerTab.get(snapshot.id) === url) return;
    lastUrlPerTab.set(snapshot.id, url);
    historyManager.record(url, snapshot.title);
  });

  // 监听 AI 设置变更：当 ai.apiKey / ai.baseUrl / ai.model / ai.providerId 变化时，
  // dispose 已加载的 Provider 子进程，下次调用 ai.chat.start 时会以新配置重新 spawn。
  // 这是必要的，因为 Provider 子进程在 init 时接收配置并缓存，不会主动重新读取。
  settingsManager.on('changed', (key) => {
    if (
      key === 'ai.apiKey' ||
      key === 'ai.baseUrl' ||
      key === 'ai.model' ||
      key === 'ai.providerId'
    ) {
      log.info('AI settings changed, disposing providers for config reload', { key });
      void orchestrator.disposeAll();
    }
  });

  // 扫描 Provider 注册表（W4：加载已安装的 AI Provider）
  // 先确保内置 OpenAI 兼容 Provider 已部署到 userData/providers 目录
  ensureBuiltinProviders(providersDir);
  providerRegistry.scan();

  // 安装 TabManager ↔ WindowManager 集成（BrowserView 挂载 + 事件推送）
  tabViewIntegration = installTabViewIntegration(tabManager, windowManager);

  // 创建主窗口
  const mainWindow = windowManager.createWindow({});

  // 为主窗口创建初始 tab
  tabManager.create({ windowId: mainWindow.id });

  // macOS：点击 dock 图标时重新创建窗口
  app.on('activate', () => {
    if (windowManager.getCount() === 0) {
      const win = windowManager.createWindow({});
      tabManager.create({ windowId: win.id });
    }
  });
});

// 所有窗口关闭时退出（Windows/Linux）
// macOS 不退出（保留 dock 常驻），清理流程由 before-quit 接管
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * 退出清理流程：在进程退出前释放所有原生资源。
 *
 * 清理顺序（先停止外部 I/O，再关闭本地句柄）：
 * 1. orchestrator.disposeAll()：kill 所有 Provider utility process，清理心跳/空闲定时器，关闭 MessagePort
 * 2. tabManager.disposeAll()：显式 destroy 所有 tab 的 webContents（释放渲染进程线程 + GPU）
 * 3. windowManager：destroy 所有 BrowserWindow
 * 4. tabViewIntegration.dispose()：清理 tab 事件节流定时器
 * 5. 等待短暂宽限期让 utility process 实际退出（kill 信号异步生效）
 * 6. storageLayer.close()：关闭所有 better-sqlite3 连接（main / ai / 命名空间连接池），触发 WAL checkpoint
 *
 * 设计要点：
 * - 异步执行并 await disposeAll，确保子进程 kill 信号发出后再继续
 * - 使用 isCleaningUp + cleanupDone 双标志位处理 before-quit 重入
 * - 清理完成后由调用方 app.exit(0) 真正退出
 */
async function performCleanup(): Promise<void> {
  if (isCleaningUp) return;
  isCleaningUp = true;
  try {
    // 0. abort 所有活跃 AI 流（chat + agent）
    //    必须在 orchestrator.disposeAll 之前调用：先 abort 流间接触发 stream.ts / pi-event-bridge.ts
    //    的 cleanup()，释放 listener 和 rendererPort；再 disposeAll kill 子进程。
    //    若先 kill 子进程，stream 会因 port 断开间接终止，但 cleanup() 不会被调用，listener 泄漏。
    if (aiHandlersDispose) {
      try {
        aiHandlersDispose();
      } catch (e) {
        log.error('Failed to dispose AI handlers on quit', { error: String(e) });
      }
      aiHandlersDispose = null;
    }

    // 1. 清理 AI Provider 子进程（utility process）+ 定时器 + MessagePort
    if (orchestrator) {
      try {
        // await 确保 disposeAll 内所有 kill/postMessage/port.close 同步执行完毕
        await orchestrator.disposeAll();
      } catch (e) {
        log.error('Failed to dispose orchestrator on quit', { error: String(e) });
      }
    }

    // 2. 显式销毁所有 tab 的 webContents（BrowserView webContents 不会随 window 自动回收）
    try {
      tabManager.disposeAll();
    } catch (e) {
      log.error('Failed to dispose tabs on quit', { error: String(e) });
    }

    // 3. 销毁所有 BrowserWindow
    try {
      for (const win of windowManager.getAllWindows()) {
        if (!win.browserWindow.isDestroyed()) {
          win.browserWindow.destroy();
        }
      }
    } catch (e) {
      log.error('Failed to destroy windows on quit', { error: String(e) });
    }

    // 4. 清理 tab 集成的节流定时器（view-integration.ts 的 updatedThrottleTimer）
    if (tabViewIntegration) {
      try {
        tabViewIntegration.dispose();
      } catch (e) {
        log.error('Failed to dispose tabViewIntegration on quit', { error: String(e) });
      }
      tabViewIntegration = null;
    }

    // 5. 宽限期：utility process 的 kill 信号已发出但进程实际退出需要短暂时间，
    //    等待 150ms 让子进程完成退出，避免主进程先退导致子进程残留
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    // 6. 关闭 SQLite 数据库连接（释放 better-sqlite3 原生线程，触发 WAL checkpoint）
    if (storageLayer) {
      try {
        storageLayer.close();
      } catch (e) {
        log.error('Failed to close storageLayer on quit', { error: String(e) });
      }
      storageLayer = null;
    }

    cleanupDone = true;
    log.info('cleanup completed, exiting process');
  } catch (e) {
    log.error('Unexpected error during cleanup', { error: String(e) });
    cleanupDone = true;
  }
}

/**
 * before-quit：Electron 退出流程的最后机会，覆盖所有平台（含 macOS Cmd+Q）。
 *
 * 第一次进入：preventDefault 阻止默认退出 → 异步执行 performCleanup → 完成后 app.exit(0)。
 * app.exit(0) 会再次触发 before-quit，此时 cleanupDone=true 直接放行，进程真正退出。
 */
app.on('before-quit', (event) => {
  if (cleanupDone) return; // 清理已完成，让默认退出继续
  if (isCleaningUp) {
    // 清理进行中，阻止重复退出
    event.preventDefault();
    return;
  }
  event.preventDefault();
  void performCleanup().then(() => {
    app.exit(0);
  });
});

/**
 * 信号处理：Ctrl+C (SIGINT) 和 kill 命令 (SIGTERM)。
 * 转发到统一异步清理流程，完成后再 app.exit()。
 * 注意：Electron 主进程默认不处理 SIGINT/SIGTERM，需显式注册。
 */
process.on('SIGINT', () => {
  log.info('SIGINT received, performing cleanup');
  void performCleanup().then(() => app.exit(0));
});

process.on('SIGTERM', () => {
  log.info('SIGTERM received, performing cleanup');
  void performCleanup().then(() => app.exit(0));
});

// 第二实例聚焦已有窗口（单实例锁配合）
app.on('second-instance', () => {
  const windows = windowManager.getAllWindows();
  if (windows.length > 0) {
    const win = windows[0]!;
    win.browserWindow.show();
    win.browserWindow.restore();
  }
});

// 全局错误兜底（02-架构设计 §5 错误传播策略）
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { message: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: String(reason) });
});
