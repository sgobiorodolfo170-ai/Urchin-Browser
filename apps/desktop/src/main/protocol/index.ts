/**
 * urchin:// 内部协议模块入口
 *
 * 依据：02-架构设计 §4 安全边界 / 04-模块全景 M7
 * 职责：
 * 1. 注册 urchin: scheme 为特权协议（支持 fetch、storage、cookies）
 * 2. 注册 urchin:// 协议处理器
 * 3. 路由 urchin://settings → 设置页 HTML
 *
 * 必须在 app.whenReady() 之前调用 registerSchemesAsPrivileged，
 * 在 app.whenReady() 之后调用 registerUrchinProtocol。
 */
import { protocol } from 'electron';
import { createLogger } from '@urchin/logger';
import { getBookmarkPanelHtml } from '../panel/bookmark-panel';

const log = createLogger('urchin-protocol');

/** urchin:// 协议的 scheme 名（不含冒号） */
export const URCHIN_SCHEME = 'urchin';

/**
 * 注册 urchin: 为特权协议（必须在 app ready 之前调用）。
 *
 * 特权：标准、支持 fetch、Bypass CSP、secure、允许 service workers。
 */
export function registerUrchinSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: URCHIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ]);
  log.info('urchin scheme registered as privileged');
}

/**
 * 注册 urchin:// 协议处理器（必须在 app ready 之后调用）。
 *
 * 路由：
 * - urchin://settings → 设置页 HTML（由主窗口 React SettingsPage 渲染，BrowserView 仅占位）
 * - urchin://ai → AI 模块页 HTML（由主窗口 React AiChatView 渲染，BrowserView 仅占位）
 * - urchin://panel → 收藏夹悬浮面板 HTML（独立子窗口加载，preload 在 urchin: 协议下暴露 API）
 * - urchin://newtab → 空白页（占位，v0.1 返回简单 HTML）
 * - 其他 → 404
 *
 * 设计理由（阶段2 解耦决策）：
 * settings 和 ai 都作为「React 渲染的内部页面」，BrowserView 加载空白 HTML 仅作为占位，
 * 实际 UI 由主窗口 React 组件覆盖渲染。这样：
 * 1. 不需要在 BrowserView 中注入 preload（避免沙箱问题）
 * 2. AI 模块作为独立标签页存在，与浏览器核心 UI 解耦
 * 3. 设置页与 AI 页共享同一渲染机制，便于统一管理
 */
export function registerUrchinProtocol(): void {
  protocol.handle(URCHIN_SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname;

      if (host === 'settings') {
        // 设置页由主窗口 React 组件渲染（SettingsPage），BrowserView 仅加载空白页面。
        // 这样避免 BrowserView 在无 preload 环境下调用 window.urchin 而报错。
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>设置</title></head><body></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }

      if (host === 'ai') {
        // AI 模块页由主窗口 React 组件渲染（AiChatView），BrowserView 仅加载空白页面。
        // AI 模块作为独立标签页应用，与浏览器核心 UI 解耦。
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AI 助手</title></head><body></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }

      if (host === 'panel') {
        // 收藏夹悬浮面板（独立子窗口加载）。preload 在 urchin: 协议下暴露
        // window.urchin.invoke，面板内联 JS 通过它拉取书签/历史/下载数据并操作。
        return new Response(getBookmarkPanelHtml(), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (host === 'newtab') {
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>新标签页</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#666;background:#fff}h1{font-weight:300}</style></head><body><h1>Urchin Browser</h1></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }

      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    } catch (err) {
      log.error('protocol handler error', { error: String(err) });
      return new Response(`Protocol handler error: ${String(err)}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  });
  log.info('urchin protocol handler registered');
}
