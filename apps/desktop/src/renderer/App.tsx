/**
 * Urchin Browser · 根组件（W2-D1）
 *
 * 验证：
 * 1. React 渲染链路通
 * 2. preload 暴露的 window.urchin.invoke 可调用 Main
 * 3. IPC 双向 zod 校验链路通
 * 4. window.create / window.close 链路可用（M1 Window Lifecycle）
 * 5. M19 主题切换可用
 *
 * D3 起替换为真正的 TabBar + Omnibox + SidePanel 布局。
 */
import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from './components/ui/button';
import { useTheme } from './theme/theme-provider';

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
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { theme, toggleTheme } = useTheme();
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [tabInfo, setTabInfo] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [windowCount, setWindowCount] = useState<string>('');

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

  /** 测试创建新窗口 */
  async function handleCreateWindow() {
    try {
      const result = (await window.urchin.invoke('window.create', {
        incognito: false,
      })) as { windowId: number };
      setWindowCount(`新窗口已创建 · windowId=${result.windowId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Urchin Browser</h1>
        <Button variant="ghost" size="sm" onClick={toggleTheme} aria-label="切换主题">
          {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
      </div>
      <p className="mb-6 text-text-secondary">AI 原生 + 开发者友好的桌面浏览器</p>

      <div className="mb-4 rounded-lg bg-surface-secondary p-4">
        <strong>环境信息</strong>
        <div className="mt-2 text-sm">
          <div>平台：{window.urchin.platform}</div>
          <div>Electron：{window.urchin.versions.electron}</div>
          <div>Chromium：{window.urchin.versions.chrome}</div>
          <div>Node：{window.urchin.versions.node}</div>
        </div>
      </div>

      <div
        className={`mb-4 rounded-lg border p-4 ${
          status === 'error'
            ? 'border-error bg-error/10'
            : status === 'ok'
              ? 'border-success bg-success/10'
              : 'border-warning bg-warning/10'
        }`}
      >
        <strong>IPC 链路验证</strong>
        {status === 'loading' && <div className="mt-2">正在调用 tab.create...</div>}
        {status === 'ok' && (
          <div className="mt-2">
            <span className="text-success">✓ 通过</span> · {tabInfo}
          </div>
        )}
        {status === 'error' && (
          <div className="mt-2">
            <span className="text-error">✗ 失败</span> · {error}
          </div>
        )}
      </div>

      <div className="mb-4 rounded-lg border border-info/30 bg-info/5 p-4">
        <strong>M1 Window Lifecycle</strong>
        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={() => void handleCreateWindow()}>
            创建新窗口
          </Button>
          {windowCount && <span className="ml-3 text-sm">{windowCount}</span>}
        </div>
      </div>

      <p className="mt-6 text-xs text-text-secondary">
        v0.1.0-dev · W2-D1 M19 Theme System · 详见 docs/07-立项准备.md
      </p>
    </div>
  );
}
