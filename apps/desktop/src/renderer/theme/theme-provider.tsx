/**
 * M19 主题系统 · ThemeProvider
 *
 * 依据：契约 K §3 / TH3 决策
 * 职责：管理亮色/暗色主题切换，通过 data-theme 属性应用到 <html>。
 *
 * 设计理由：
 * - 使用 React Context 共享主题状态，避免 prop drilling
 * - 通过 data-theme 属性切换 CSS 变量，性能优于 JS 手动覆盖
 * - 持久化到 localStorage，下次启动恢复
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';

interface ThemeContextValue {
  readonly theme: Theme;
  setTheme(theme: Theme): void;
  toggleTheme(): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'urchin-theme';

/**
 * 获取初始主题：localStorage > 系统偏好 > light。
 */
function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }

  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }

  return 'light';
}

interface ThemeProviderProps {
  readonly children: ReactNode;
  readonly defaultTheme?: Theme;
}

export function ThemeProvider({ children, defaultTheme }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(defaultTheme ?? getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
    // 通知主进程：设置 nativeTheme.themeSource，使窗口标题栏跟随主题、
    // 支持 prefers-color-scheme 的网页（BrowserView）跟随主题（Chrome 深色模式行为）。
    // best-effort：window.urchin 不可用或 invoke 返回 undefined（测试环境）时静默，
    // 不影响 data-theme UI 主题。
    try {
      const p = window.urchin?.invoke('ui.theme.set', { theme });
      if (p instanceof Promise) {
        p.catch(() => {
          // 忽略：主题已通过 data-theme 生效，主进程同步失败不阻塞 UI
        });
      }
    } catch {
      // 忽略：测试环境等无 urchin 场景
    }
  }, [theme]);

  const setTheme = (next: Theme): void => {
    setThemeState(next);
  };

  const toggleTheme = (): void => {
    setThemeState((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * 使用主题上下文。
 *
 * @throws 若在 ThemeProvider 外调用
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}
