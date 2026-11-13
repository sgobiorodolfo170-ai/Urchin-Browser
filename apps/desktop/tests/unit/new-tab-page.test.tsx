import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NewTabPage } from '../../src/renderer/home/NewTabPage';

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);
it('收藏夹按站点展示，单页直接导航，多页弹窗按时间倒序，变更同步', async () => {
  let changed: () => void = vi.fn();
  let bookmarks = [
    { type: 'bookmark', url: 'https://example.com/old', title: '旧页面', createdAt: 1 },
    { type: 'bookmark', url: 'https://example.com/new', title: '新页面', createdAt: 3 },
    { type: 'bookmark', url: 'https://single.test/path', title: '单页', createdAt: 2 },
    { type: 'folder', title: '文件夹', createdAt: 4 },
  ];
  const invoke = vi.fn((channel: string) =>
    Promise.resolve(
      channel === 'bookmark.list'
        ? { bookmarks }
        : {
            entries: [{ url: 'https://recent.test/path', title: '访问页面', visitedAt: 5 }],
            total: 1,
          },
    ),
  );
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    value: {
      invoke,
      on: (_: string, callback: () => void) => {
        changed = callback;
        return vi.fn();
      },
    },
  });
  const navigate = vi.fn();
  render(<NewTabPage onNavigate={navigate} />);
  fireEvent.click(await screen.findByTitle('single.test'));
  expect(navigate).toHaveBeenCalledWith('https://single.test/path');
  fireEvent.click(screen.getByTitle('example.com'));
  const list = screen.getByRole('dialog');
  expect(
    within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['新页面https://example.com/new', '旧页面https://example.com/old']);
  fireEvent.click(within(list).getByText('旧页面'));
  expect(navigate).toHaveBeenLastCalledWith('https://example.com/old');
  fireEvent.click(screen.getByTitle('recent.test'));
  expect(within(screen.getByRole('dialog')).getByText('访问页面')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('关闭列表'));
  bookmarks = [];
  changed();
  expect(await screen.findByText('收藏网页后，将自动显示在这里')).toBeInTheDocument();
});

it('长按拖入常用网站会创建最近浏览文件夹并收藏，重排顺序持久化', async () => {
  const bookmarks: Record<string, unknown>[] = [];
  const history = [
    { url: 'https://recent.test/new', title: '新', visitedAt: 2 },
    { url: 'https://recent.test/old', title: '旧', visitedAt: 1 },
  ];
  const invoke = vi.fn((channel: string, payload: Record<string, unknown>) => {
    if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [...bookmarks] });
    if (channel === 'history.list') return Promise.resolve({ entries: history, total: 2 });
    if (channel === 'settings.get') return Promise.resolve({ value: [] });
    if (channel === 'bookmark.create') {
      const bookmark = { ...payload, id: `id-${bookmarks.length}`, createdAt: bookmarks.length };
      bookmarks.push(bookmark);
      return Promise.resolve({ bookmark });
    }
    return Promise.resolve({});
  });
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    value: { invoke, on: () => vi.fn() },
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  // jsdom 不实现 PointerEvent，使用 MouseEvent 保留坐标和 button。
  vi.stubGlobal('PointerEvent', MouseEvent);
  const navigate = vi.fn();
  render(<NewTabPage onNavigate={navigate} />);
  const source = await screen.findByTitle('recent.test');
  const zone = screen.getByTestId('frequent-sites');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => zone });
  fireEvent.pointerDown(source, { button: 0, clientX: 20, clientY: 200 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  fireEvent.pointerMove(source, { clientX: 20, clientY: 80 });
  fireEvent.pointerUp(source, { clientX: 20, clientY: 80 });
  fireEvent.click(source);
  await waitFor(() =>
    expect(
      within(screen.getByTestId('frequent-sites')).getByTitle('recent.test'),
    ).toBeInTheDocument(),
  );
  expect(screen.queryByText('已收藏到常用网站')).not.toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith('bookmark.create', {
    type: 'folder',
    parentId: null,
    title: '最近浏览',
  });
  expect(bookmarks.filter((b) => b.type === 'bookmark').map((b) => b.url)).toEqual([
    'https://recent.test/old',
    'https://recent.test/new',
  ]);
  expect(invoke).toHaveBeenCalledWith('settings.set', {
    key: 'home.frequentSiteOrder',
    value: ['recent.test'],
  });
  const recentZone = screen.getByRole('region', { name: '最近浏览' });
  const again = within(recentZone).getByTitle('recent.test');
  fireEvent.pointerDown(again, { button: 0 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  fireEvent.pointerUp(again, { clientX: 20, clientY: 80 });
  await waitFor(() =>
    expect(invoke.mock.calls.filter((call) => call[0] === 'settings.set')).toHaveLength(2),
  );
  expect(bookmarks).toHaveLength(3);
  vi.unstubAllGlobals();
});

it('保存的常用图标顺序优先，长按重排保存新顺序且不打开网页', async () => {
  const invoke = vi.fn((channel: string, payload: Record<string, unknown>) => {
    if (channel === 'settings.get')
      return Promise.resolve({
        value: payload.key === 'home.frequentSiteOrder' ? ['a.test', 'b.test'] : [],
      });
    if (channel === 'bookmark.list')
      return Promise.resolve({
        bookmarks: [
          { type: 'bookmark', url: 'https://b.test/page', title: 'B', createdAt: 2 },
          { type: 'bookmark', url: 'https://a.test/page', title: 'A', createdAt: 1 },
        ],
      });
    if (channel === 'history.list') return Promise.resolve({ entries: [], total: 0 });
    return Promise.resolve({});
  });
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    value: { invoke, on: () => vi.fn() },
  });
  vi.stubGlobal('PointerEvent', MouseEvent);
  const navigate = vi.fn();
  render(<NewTabPage onNavigate={navigate} />);
  const zone = screen.getByTestId('frequent-sites');
  await waitFor(() =>
    expect(
      within(zone)
        .getAllByRole('button')
        .map((b) => b.title),
    ).toEqual(['a.test', 'b.test']),
  );
  const source = within(zone).getByTitle('b.test');
  const target = within(zone).getByTitle('a.test');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
  fireEvent.pointerDown(source, { button: 0 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  fireEvent.pointerUp(source, { clientX: 20, clientY: 20 });
  fireEvent.click(source);
  await waitFor(() =>
    expect(
      within(zone)
        .getAllByRole('button')
        .map((b) => b.title),
    ).toEqual(['b.test', 'a.test']),
  );
  expect(invoke).toHaveBeenCalledWith('settings.set', {
    key: 'home.frequentSiteOrder',
    value: ['b.test', 'a.test'],
  });
  expect(navigate).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('120ms 后图标锁定光标，拖出常用区删除该站所有收藏，保留文件夹和其他网站', async () => {
  let bookmarks = [
    { id: 'folder', type: 'folder', title: '最近浏览', parentId: null, createdAt: 0 },
    {
      id: 'a1',
      type: 'bookmark',
      title: 'A1',
      url: 'https://a.test/one',
      parentId: null,
      createdAt: 1,
    },
    {
      id: 'a2',
      type: 'bookmark',
      title: 'A2',
      url: 'https://www.a.test/two',
      parentId: 'folder',
      createdAt: 2,
    },
    {
      id: 'a3',
      type: 'bookmark',
      title: '重复收藏',
      url: 'https://a.test/one',
      parentId: 'folder',
      createdAt: 3,
    },
    {
      id: 'b',
      type: 'bookmark',
      title: 'B',
      url: 'https://b.test/page',
      parentId: null,
      createdAt: 4,
    },
  ];
  const invoke = vi.fn((channel: string, payload: Record<string, unknown>) => {
    if (channel === 'bookmark.list') return Promise.resolve({ bookmarks });
    if (channel === 'history.list') return Promise.resolve({ entries: [], total: 0 });
    if (channel === 'settings.get') return Promise.resolve({ value: [] });
    if (channel === 'bookmark.delete') bookmarks = bookmarks.filter((b) => b.id !== payload.id);
    return Promise.resolve({});
  });
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    value: { invoke, on: () => vi.fn() },
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => document.body,
  });
  vi.stubGlobal('PointerEvent', MouseEvent);
  render(<NewTabPage onNavigate={vi.fn()} />);
  const source = await screen.findByTitle('a.test');
  expect(screen.queryByRole('heading', { name: '常用网站' })).not.toBeInTheDocument();
  // 未到长按阈值就松手，不可删除。
  fireEvent.pointerDown(source, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(source, { clientX: 150, clientY: 150 });
  expect(invoke).not.toHaveBeenCalledWith('bookmark.delete', expect.anything());
  fireEvent.pointerDown(source, { button: 0, clientX: 100, clientY: 100 });
  // 等待前的轻微移动也必须保留抓取，并使用最新坐标。
  fireEvent.pointerMove(source, { clientX: 120, clientY: 130 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  expect(screen.getByTestId('dragged-site-icon')).toHaveStyle({ left: '100px', top: '110px' });
  expect(source).toHaveStyle({ opacity: '0' });
  fireEvent.pointerMove(source, { clientX: 220, clientY: 250 });
  expect(screen.getByTestId('dragged-site-icon')).toHaveStyle({ left: '200px', top: '230px' });
  fireEvent.pointerUp(source, { clientX: 220, clientY: 250 });
  expect(await screen.findByText('已移出常用网站并取消该网站的收藏')).toBeInTheDocument();
  expect(bookmarks.map((b) => b.id)).toEqual(['folder', 'b']);
  expect(screen.queryByTitle('a.test')).not.toBeInTheDocument();
  expect(screen.getByTitle('b.test')).toBeInTheDocument();
  vi.unstubAllGlobals();
});

it('长按超过120ms但未移动仍可点击打开网页', async () => {
  const invoke = vi.fn((channel: string) =>
    Promise.resolve(
      channel === 'bookmark.list'
        ? {
            bookmarks: [
              { type: 'bookmark', url: 'https://single.test/path', title: '单页', createdAt: 1 },
            ],
          }
        : channel === 'settings.get'
          ? { value: [] }
          : { entries: [], total: 0 },
    ),
  );
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    value: { invoke, on: () => vi.fn() },
  });
  vi.stubGlobal('PointerEvent', MouseEvent);
  const navigate = vi.fn();
  render(<NewTabPage onNavigate={navigate} />);
  const source = await screen.findByTitle('single.test');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => source });
  fireEvent.pointerDown(source, { button: 0, clientX: 100, clientY: 100 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160));
  });
  fireEvent.pointerUp(source, { clientX: 100, clientY: 100 });
  fireEvent.click(source);
  expect(navigate).toHaveBeenCalledWith('https://single.test/path');
  expect(invoke).not.toHaveBeenCalledWith('bookmark.delete', expect.anything());
  vi.unstubAllGlobals();
});
