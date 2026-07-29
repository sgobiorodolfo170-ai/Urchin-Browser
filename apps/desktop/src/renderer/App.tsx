/**
 * Urchin Browser · 根组件（W1-D1 最小骨架）
 *
 * 验证：
 * 1. React 渲染链路通
 * 2. preload 暴露的 window.urchin.invoke 可调用 Main
 * 3. IPC 双向 zod 校验链路通
 *
 * D2 起替换为真正的 TabBar + Omnibox + SidePanel 布局。
 */
import { useEffect, useState } from 'react';

// 渲染层通过 window.urchin 访问 preload 暴露的 API
declare global {
  interface Window {
    readonly urchin: {
      invoke: <C extends string>(channel: C, req: unknown) => Promise<unknown>;
      readonly platform: string;
      readonly versions: {
        readonly electron: string;
        readonly chrome: string;
        readonly node: string;
      };
    };
  }
}

export function App() {
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [tabInfo, setTabInfo] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    async function verifyIpc() {
      try {
        const result = (await window.urchin.invoke('tab.create', {
          windowId: 1,
          url: 'about:blank',
        })) as { tab: { id: number; url: string; title: string } };

        setTabInfo(`Tab #${result.tab.id} · ${result.tab.url} · ${result.tab.title}`);
        setStatus('ok');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    }
    void verifyIpc();
  }, []);

  return (
    <div
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: 32,
        maxWidth: 800,
        margin: '0 auto',
      }}
    >
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Urchin Browser</h1>
      <p style={{ color: '#666', marginBottom: 24 }}>AI 原生 + 开发者友好的桌面浏览器</p>

      <div
        style={{
          padding: 16,
          borderRadius: 8,
          background: '#f5f5f5',
          marginBottom: 16,
        }}
      >
        <strong>环境信息</strong>
        <div style={{ marginTop: 8, fontSize: 14 }}>
          <div>平台：{window.urchin.platform}</div>
          <div>Electron：{window.urchin.versions.electron}</div>
          <div>Chromium：{window.urchin.versions.chrome}</div>
          <div>Node：{window.urchin.versions.node}</div>
        </div>
      </div>

      <div
        style={{
          padding: 16,
          borderRadius: 8,
          background: status === 'error' ? '#fee' : status === 'ok' ? '#efe' : '#ffe',
          border: `1px solid ${status === 'error' ? '#c33' : status === 'ok' ? '#3c3' : '#cc3'}`,
        }}
      >
        <strong>IPC 链路验证</strong>
        {status === 'loading' && <div style={{ marginTop: 8 }}>正在调用 tab.create...</div>}
        {status === 'ok' && (
          <div style={{ marginTop: 8 }}>
            <span style={{ color: '#3c3' }}>✓ 通过</span> · {tabInfo}
          </div>
        )}
        {status === 'error' && (
          <div style={{ marginTop: 8 }}>
            <span style={{ color: '#c33' }}>✗ 失败</span> · {error}
          </div>
        )}
      </div>

      <p style={{ marginTop: 24, fontSize: 12, color: '#999' }}>
        v0.1.0-dev · W1-D1 脚手架验证 · 详见 docs/07-立项准备.md
      </p>
    </div>
  );
}
