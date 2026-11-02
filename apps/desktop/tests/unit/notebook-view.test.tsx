/**
 * M27 笔记 · 页面组件交互单测
 *
 * 覆盖：默认状态加载、笔记/任务切换、任务勾选、笔记编辑、新建笔记、
 * 三区分割线拖拽与持久化。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotebookView } from '../../src/renderer/notebook/NotebookView';
import { NOTEBOOK_STATE_KEY } from '../../src/renderer/notebook/types';

type Invoke = (channel: string, req: unknown) => Promise<unknown>;

function installUrchin(invoke: Invoke): void {
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    value: {
      invoke,
      on: () => () => undefined,
      onMessagePort: () => () => undefined,
      platform: 'win32',
      versions: { electron: '0', chrome: '0', node: '0' },
    },
  });
}

function renderView() {
  return render(<NotebookView />);
}

describe('NotebookView', () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invoke = vi.fn((channel: string) => {
      if (channel === 'settings.get') return Promise.resolve({ value: null });
      if (channel === 'settings.set') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    installUrchin(invoke as Invoke);
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('should load default notebook and switch to task list', async () => {
    renderView();

    expect(await screen.findByText('我的笔记本')).toBeInTheDocument();
    expect(screen.getAllByText('欢迎使用笔记').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText('切换到任务清单'));
    const input = await screen.findByPlaceholderText('添加任务后按 Enter');
    fireEvent.change(input, { target: { value: '买牛奶' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('买牛奶')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('标记为已完成'));
    expect(screen.getByLabelText('标记为未完成')).toBeInTheDocument();
  });

  it('should open a note, edit content, and return to list', async () => {
    renderView();

    await screen.findByText('我的笔记本');
    fireEvent.click(screen.getAllByText('欢迎使用笔记')[0]!);

    const body = await screen.findByLabelText('笔记正文');
    expect((body as HTMLTextAreaElement).value).toContain('任务清单');

    fireEvent.change(body, { target: { value: '更新后的正文' } });
    expect((body as HTMLTextAreaElement).value).toBe('更新后的正文');

    fireEvent.click(screen.getByLabelText('返回笔记列表'));
    expect(await screen.findByLabelText('新建笔记')).toBeInTheDocument();
  });

  it('should create a new note from the + button', async () => {
    renderView();

    await screen.findByText('我的笔记本');
    fireEvent.click(screen.getByLabelText('新建笔记'));

    const title = await screen.findByLabelText('笔记标题');
    fireEvent.change(title, { target: { value: '新的想法' } });
    expect((title as HTMLInputElement).value).toBe('新的想法');
  });

  it('should persist splitter position after dragging', async () => {
    renderView();

    await screen.findByText('我的笔记本');
    const splitter = screen.getByLabelText('调整导航区宽度');

    fireEvent.pointerDown(splitter, { pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 560 });
    fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 560 });

    await waitFor(
      () => {
        const calls = invoke.mock.calls.filter((call) => call[0] === 'settings.set');
        expect(calls.length).toBeGreaterThan(0);
        const req = calls[calls.length - 1]?.[1] as {
          key: string;
          value: { layout?: { custom?: boolean; left?: number } };
        };
        expect(req.key).toBe(NOTEBOOK_STATE_KEY);
        expect(req.value.layout?.custom).toBe(true);
        // 比例制：左区比例应大于默认 0.2
        expect(req.value.layout?.left).toBeGreaterThan(0.2);
      },
      { timeout: 2000 },
    );
  });
});
