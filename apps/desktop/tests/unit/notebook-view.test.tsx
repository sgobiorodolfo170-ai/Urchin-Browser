/**
 * M27 笔记 · 页面组件交互单测
 *
 * 覆盖：默认状态加载、笔记/任务切换、任务勾选、笔记编辑、新建笔记、
 * 三区分割线拖拽与持久化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  afterEach(() => vi.unstubAllGlobals());

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

  it('should increase and decrease sticky font size', async () => {
    renderView();

    await screen.findByText('我的笔记本');
    fireEvent.click(screen.getByLabelText('新建便利贴'));

    const stickyText = screen.getByLabelText<HTMLTextAreaElement>('便利贴内容');
    expect(stickyText.style.fontSize).toBe('14px');

    fireEvent.click(screen.getByLabelText('放大字号'));
    expect(screen.getByLabelText<HTMLTextAreaElement>('便利贴内容').style.fontSize).toBe('15px');

    fireEvent.click(screen.getByLabelText('缩小字号'));
    expect(screen.getByLabelText<HTMLTextAreaElement>('便利贴内容').style.fontSize).toBe('14px');
  });

  it('should render canvas image and zoom it on wheel', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'settings.get') {
        return Promise.resolve({
          value: {
            version: 1,
            notebooks: [{ id: 'nb-1', name: '我的笔记本', createdAt: 1 }],
            notes: [],
            tasks: [],
            stickies: [],
            images: [
              {
                id: 'img-1',
                notebookId: 'nb-1',
                filePath: 'C:\\a.png',
                x: 0,
                y: 0,
                width: 200,
                height: 150,
                scale: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            activeNotebookId: 'nb-1',
            activeNoteId: null,
            middleMode: 'notes',
            expandedNotebookIds: ['nb-1'],
            viewports: {},
            layout: null,
          },
        });
      }
      if (channel === 'settings.set') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    renderView();

    const image = await screen.findByLabelText('画布图片');
    expect(within(image).getByText('100%')).toBeInTheDocument();

    fireEvent.wheel(image, { deltaY: -120 });
    await waitFor(() => expect(within(image).getByText('110%')).toBeInTheDocument());
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
  it('inserts a transit text file at the note selection without creating another note', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'file.read') return Promise.resolve({ content: '插入文字' });
      if (channel === 'settings.get') return Promise.resolve({ value: null });
      return Promise.resolve({ ok: true });
    });
    renderView();
    await screen.findByText('我的笔记本');
    fireEvent.click(screen.getAllByText('欢迎使用笔记')[0]!);
    const body = await screen.findByLabelText<HTMLTextAreaElement>('笔记正文');
    fireEvent.change(body, { target: { value: '前后' } });
    body.setSelectionRange(1, 1);
    fireEvent.drop(body, {
      dataTransfer: {
        getData: () =>
          JSON.stringify({
            id: 'file-1',
            kind: 'file',
            title: 'sample.txt',
            filePath: 'C:\\sample.txt',
            createdAt: Date.now(),
          }),
      },
    });
    await waitFor(() => expect(body.value).toBe('前插入文字后'));
    expect(invoke).toHaveBeenCalledWith('file.read', { path: 'C:\\sample.txt', maxBytes: 800000 });
  });

  it('allows placing a cursor in task text after double click', async () => {
    renderView();
    await screen.findByText('我的笔记本');
    fireEvent.click(screen.getByLabelText('切换到任务清单'));
    fireEvent.change(screen.getByLabelText('新任务'), { target: { value: '可选择的任务' } });
    fireEvent.keyDown(screen.getByLabelText('新任务'), { key: 'Enter' });
    fireEvent.doubleClick(await screen.findByText('可选择的任务'));
    expect(screen.getByLabelText('任务内容')).toHaveValue('可选择的任务');
  });
  it('renders transit audio and video files with playback controls on the canvas', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.stubGlobal('DragEvent', MouseEvent);
    renderView();
    await screen.findByText('我的笔记本');
    const canvas = screen.getByLabelText('便利贴画布');
    for (const [name, mimeType] of [
      ['clip.mp4', 'video/mp4'],
      ['song.mp3', 'audio/mpeg'],
    ]) {
      fireEvent.drop(canvas, {
        clientX: 300,
        clientY: 200,
        dataTransfer: {
          files: [],
          getData: () =>
            JSON.stringify({
              id: name,
              kind: 'file',
              title: name,
              filePath: 'C:\\' + name,
              mimeType,
              createdAt: Date.now(),
            }),
        },
      });
    }
    expect(canvas.querySelector('video')).toHaveAttribute('controls');
    expect(canvas.querySelector('audio')).toHaveAttribute('controls');
    expect(screen.getByText('画布')).toBeInTheDocument();
    const audioCard = screen.getByLabelText('画布音频');
    const beforeLeft = parseFloat(audioCard.style.left);
    fireEvent.pointerDown(screen.getByText('song.mp3'), {
      button: 0,
      pointerId: 1,
      clientX: 300,
      clientY: 200,
    });
    fireEvent.pointerMove(audioCard, { pointerId: 1, clientX: 360, clientY: 240 });
    fireEvent.pointerUp(audioCard, { pointerId: 1 });
    expect(parseFloat(audioCard.style.left)).toBeGreaterThan(beforeLeft);
    const afterLeft = audioCard.style.left;
    fireEvent.pointerDown(audioCard.querySelector('audio')!, {
      button: 0,
      pointerId: 2,
      clientX: 300,
      clientY: 200,
    });
    fireEvent.pointerMove(audioCard, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerUp(audioCard, { pointerId: 2 });
    expect(audioCard.style.left).toBe(afterLeft);
  });
});
