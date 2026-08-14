/**
 * ThemeProvider 单元测试（W2-D1）
 *
 * 验证：
 * 1. 默认主题应用 data-theme 属性
 * 2. toggleTheme 切换主题
 * 3. setTheme 设置指定主题
 * 4. useTheme 在 Provider 外抛异常
 * 5. localStorage 持久化
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, renderHook, fireEvent, screen } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../../src/renderer/theme/theme-provider';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeProvider', () => {
  it('should apply default theme to data-theme attribute', () => {
    render(
      <ThemeProvider defaultTheme="light">
        <div>test</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('should apply dark theme when defaultTheme is dark', () => {
    render(
      <ThemeProvider defaultTheme="dark">
        <div>test</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('should toggle theme', () => {
    function TestComponent() {
      const { toggleTheme } = useTheme();
      return <button onClick={toggleTheme}>toggle</button>;
    }

    render(
      <ThemeProvider defaultTheme="light">
        <TestComponent />
      </ThemeProvider>,
    );

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    fireEvent.click(screen.getByText('toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(screen.getByText('toggle'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('should set theme explicitly', () => {
    function TestComponent() {
      const { setTheme } = useTheme();
      return (
        <>
          <button onClick={() => setTheme('dark')}>dark</button>
          <button onClick={() => setTheme('light')}>light</button>
        </>
      );
    }

    render(
      <ThemeProvider defaultTheme="light">
        <TestComponent />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByText('dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(screen.getByText('light'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('should persist theme to localStorage', () => {
    function TestComponent() {
      const { toggleTheme } = useTheme();
      return <button onClick={toggleTheme}>toggle</button>;
    }

    render(
      <ThemeProvider defaultTheme="light">
        <TestComponent />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByText('toggle'));
    expect(localStorage.getItem('urchin-theme')).toBe('dark');
  });

  it('should throw when useTheme is used outside provider', () => {
    expect(() => renderHook(() => useTheme())).toThrow(/must be used within ThemeProvider/);
  });

  it('should fallback to light when no defaultTheme and no stored preference', () => {
    render(
      <ThemeProvider>
        <div>test</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('should use localStorage value when no defaultTheme', () => {
    localStorage.setItem('urchin-theme', 'dark');

    render(
      <ThemeProvider>
        <div>test</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('should notify main process via ui.theme.set when theme changes', () => {
    const mockInvoke = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'urchin', {
      value: { invoke: mockInvoke },
      writable: true,
      configurable: true,
    });

    function TestComponent() {
      const { toggleTheme } = useTheme();
      return <button onClick={toggleTheme}>toggle</button>;
    }

    render(
      <ThemeProvider defaultTheme="light">
        <TestComponent />
      </ThemeProvider>,
    );

    // 初始挂载也应通知（默认主题）
    expect(mockInvoke).toHaveBeenCalledWith('ui.theme.set', { theme: 'light' });

    fireEvent.click(screen.getByText('toggle'));
    expect(mockInvoke).toHaveBeenCalledWith('ui.theme.set', { theme: 'dark' });
  });

  it('should not crash when window.urchin is unavailable', () => {
    // 默认无 window.urchin：通知静默失败，主题仍通过 data-theme 生效
    render(
      <ThemeProvider defaultTheme="dark">
        <div>test</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('should respect prefers-color-scheme dark when no defaultTheme and no stored', () => {
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-color-scheme: dark)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
      writable: true,
      configurable: true,
    });

    render(
      <ThemeProvider>
        <div>test</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
