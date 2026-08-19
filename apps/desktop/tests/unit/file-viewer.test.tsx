/**
 * 本地文件查看器 / 文件夹浏览器（FileViewer）组件测试
 *
 * 覆盖：
 * 纯函数：
 * 1. extractViewerPath / getViewerParams：URL path/dir 参数提取
 * 2. fileResourceUrl：file-resource URL 构造（编码）
 * 3. dirname / parentDir：路径目录/上一级（含盘符根边界）
 * 4. formatBytes / formatJsonContent
 * 组件（文件查看 ?path=）：
 * 5. txt / md / json 文本渲染（回归）
 * 6. image → <img>（src = file-resource 编码 URL）；video → <video>；pdf → <iframe>
 * 7. 同类型序列：上/下一个仅在同 kind 间切换 + n/total + 方向键导航
 * 8. 文件过大 / stat 失败分支
 * 组件（目录浏览 ?dir=）：
 * 9. 文件夹+文件网格、点击进入子目录/预览文件、空目录、加载失败
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import {
  extractViewerPath,
  fileResourceUrl,
  FileViewer,
  formatBytes,
  formatJsonContent,
  getViewerParams,
  parentDir,
  dirname,
} from '../../src/renderer/files/FileViewer';

const mockInvoke = vi.fn();
beforeEach(() => {
  mockInvoke.mockReset();
  Object.defineProperty(window, 'urchin', {
    value: { invoke: mockInvoke, platform: 'win32', versions: { electron: '32.0.0' } },
    writable: true,
    configurable: true,
  });
});

// ── 纯函数测试 ──

describe('extractViewerPath / getViewerParams', () => {
  it('should extract path from viewer URL', () => {
    expect(extractViewerPath('urchin://file-viewer/?path=C%3A%5Cdocs%5Cnotes.txt')).toBe(
      'C:\\docs\\notes.txt',
    );
  });

  it('should extract dir from viewer URL', () => {
    expect(getViewerParams('urchin://file-viewer/?dir=C%3A%5CPictures')).toEqual({
      path: null,
      dir: 'C:\\Pictures',
    });
  });

  it('should return null for non-viewer URL', () => {
    expect(extractViewerPath('urchin://settings')).toBeNull();
    expect(getViewerParams('not a url at all')).toEqual({ path: null, dir: null });
  });
});

describe('fileResourceUrl', () => {
  it('should build encoded file-resource URL', () => {
    expect(fileResourceUrl('C:\\壁纸\\a.mp4')).toBe(
      'urchin://file-resource/C%3A%5C%E5%A3%81%E7%BA%B8%5Ca.mp4',
    );
  });
});

describe('dirname / parentDir', () => {
  it('should return containing directory', () => {
    expect(dirname('C:\\docs\\notes.txt')).toBe('C:\\docs');
    expect(dirname('C:/docs/a.pdf')).toBe('C:/docs');
  });

  it('should return path unchanged when no separator', () => {
    expect(dirname('notes.txt')).toBe('notes.txt');
  });

  it('should return null for drive root parent', () => {
    expect(parentDir('C:\\Users')).toBeNull();
    expect(parentDir('C:\\')).toBeNull();
  });

  it('should return parent directory', () => {
    expect(parentDir('C:\\Users\\a')).toBe('C:\\Users');
  });
});

describe('formatBytes', () => {
  it('should format bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.00 KB');
  });
});

describe('formatJsonContent', () => {
  it('should pretty-print valid JSON, keep invalid', () => {
    expect(formatJsonContent('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatJsonContent('nope')).toBe('nope');
  });
});

// ── 组件测试 · 文件查看模式 ──

/** 基础文件查看 mock：stat + 可选的 dir（序列）。 */
function mockFileViewLoad(overrides: {
  stat?: Partial<{ name: string; size: number; kind: string }>;
  dirEntries?: unknown[];
  readContent?: string;
}): void {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'file.stat') {
      return Promise.resolve({
        name: 'a.png',
        size: 1000,
        ext: 'png',
        kind: 'image',
        ...(overrides.stat ?? {}),
      });
    }
    if (channel === 'file.dir') {
      return Promise.resolve({ entries: overrides.dirEntries ?? [] });
    }
    if (channel === 'file.read') {
      return Promise.resolve({ content: overrides.readContent ?? 'content' });
    }
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
}

describe('FileViewer · 文件查看', () => {
  it('should render txt content as plain text', async () => {
    mockFileViewLoad({
      stat: { name: 'notes.txt', size: 100, kind: 'text' },
      readContent: 'hello urchin',
    });

    render(<FileViewer url="urchin://file-viewer/?path=C%3A%5Cnotes.txt" />);

    await waitFor(() => {
      expect(screen.getByText('notes.txt')).toBeDefined();
      expect(screen.getByText('hello urchin')).toBeDefined();
    });
  });

  it('should strip raw HTML from markdown output', async () => {
    mockFileViewLoad({
      stat: { name: 'readme.md', size: 200, kind: 'markdown' },
      readContent: '# Title\n<script>alert(1)</script>\nplain',
    });

    render(<FileViewer url="urchin://file-viewer/?path=C%3A%5Creadme.md" />);

    await waitFor(() => {
      const heading = document.querySelector('.prose-viewer h1');
      expect(heading?.textContent).toBe('Title');
    });
    expect(document.querySelector('.prose-viewer script')).toBeNull();
    expect(document.querySelector('.prose-viewer')?.textContent).toContain('plain');
  });

  it('should render image with file-resource src', async () => {
    mockFileViewLoad({ stat: { name: 'a.png', kind: 'image' } });

    render(<FileViewer url="urchin://file-viewer/?path=C%3A%5C%E5%A3%81%E7%BA%B8%5Ca.png" />);

    await waitFor(() => {
      const img = document.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe(
        'urchin://file-resource/C%3A%5C%E5%A3%81%E7%BA%B8%5Ca.png',
      );
    });
    // 图片不读内容
    expect(mockInvoke).not.toHaveBeenCalledWith('file.read', expect.anything());
  });

  it('should render video with controls', async () => {
    mockFileViewLoad({ stat: { name: 'a.mp4', kind: 'video' } });

    render(<FileViewer url="urchin://file-viewer/?path=C%3A%5Ca.mp4" />);

    await waitFor(() => {
      const video = document.querySelector('video');
      expect(video).not.toBeNull();
      expect(video?.getAttribute('controls')).not.toBeNull();
      expect(video?.getAttribute('src')).toContain('urchin://file-resource/');
    });
  });

  it('should render pdf in iframe', async () => {
    mockFileViewLoad({ stat: { name: 'a.pdf', kind: 'pdf' } });

    render(<FileViewer url="urchin://file-viewer/?path=C%3A%5Ca.pdf" />);

    await waitFor(() => {
      const iframe = document.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute('src')).toContain('urchin://file-resource/');
    });
  });

  it('should navigate across all previewable files in the directory (any type)', async () => {
    const onNavigate = vi.fn();
    mockFileViewLoad({
      stat: { name: 'b.png', kind: 'image' },
      dirEntries: [
        { name: 'a.png', path: 'C:\\pics\\a.png', kind: 'image', isDir: false, size: 1 },
        { name: 'movie.mp4', path: 'C:\\pics\\movie.mp4', kind: 'video', isDir: false, size: 2 },
        { name: 'b.png', path: 'C:\\pics\\b.png', kind: 'image', isDir: false, size: 3 },
        { name: 'notes.txt', path: 'C:\\pics\\notes.txt', kind: 'text', isDir: false, size: 4 },
        { name: 'setup.exe', path: 'C:\\pics\\setup.exe', kind: 'binary', isDir: false, size: 5 },
      ],
    });

    render(
      <FileViewer url="urchin://file-viewer/?path=C%3A%5Cpics%5Cb.png" onNavigate={onNavigate} />,
    );

    await waitFor(() => {
      // 同目录全部可预览文件（视频/图片/文本，exe 不支持预览除外），当前 b.png 是第 3 个
      expect(screen.getByText('3/4')).toBeDefined();
    });

    // 下一个 → notes.txt（跨类型自由切换，跳过 exe 二进制）
    fireEvent.click(screen.getByLabelText('下一个'));
    expect(onNavigate).toHaveBeenCalledWith(
      'urchin://file-viewer/?path=' + encodeURIComponent('C:\\pics\\notes.txt'),
    );

    // 上一个 → movie.mp4
    fireEvent.click(screen.getByLabelText('上一个'));
    expect(onNavigate).toHaveBeenCalledWith(
      'urchin://file-viewer/?path=' + encodeURIComponent('C:\\pics\\movie.mp4'),
    );
  });

  it('should navigate via wheel for non-scrollable content (image)', async () => {
    const onNavigate = vi.fn();
    mockFileViewLoad({
      stat: { name: 'b.png', kind: 'image' },
      dirEntries: [
        { name: 'a.png', path: 'C:\\pics\\a.png', kind: 'image', isDir: false, size: 1 },
        { name: 'b.png', path: 'C:\\pics\\b.png', kind: 'image', isDir: false, size: 3 },
      ],
    });

    render(
      <FileViewer url="urchin://file-viewer/?path=C%3A%5Cpics%5Cb.png" onNavigate={onNavigate} />,
    );
    await waitFor(() => {
      expect(screen.getByText('2/2')).toBeDefined();
    });

    // 滚轮向上（deltaY<0）→ 上一个（b.png 是最后一个，滚轮向下无动作）
    fireEvent.wheel(window, { deltaY: -100 });
    expect(onNavigate).toHaveBeenCalledWith(
      'urchin://file-viewer/?path=' + encodeURIComponent('C:\\pics\\a.png'),
    );
  });

  it('should NOT navigate via wheel for scrollable text content', async () => {
    const onNavigate = vi.fn();
    mockFileViewLoad({
      stat: { name: 'a.md', kind: 'markdown' },
      readContent: '# Title',
      dirEntries: [
        { name: 'a.md', path: 'C:\\docs\\a.md', kind: 'markdown', isDir: false, size: 1 },
        { name: 'b.md', path: 'C:\\docs\\b.md', kind: 'markdown', isDir: false, size: 2 },
      ],
    });

    render(
      <FileViewer url="urchin://file-viewer/?path=C%3A%5Cdocs%5Ca.md" onNavigate={onNavigate} />,
    );
    await waitFor(() => {
      expect(document.querySelector('.prose-viewer h1')?.textContent).toBe('Title');
    });

    // 长文档保留滚轮滚动内容，不触发切换
    fireEvent.wheel(window, { deltaY: 100 });
    fireEvent.wheel(window, { deltaY: -100 });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('should seek video with left/right and adjust volume with up/down arrows', async () => {
    const onNavigate = vi.fn();
    mockFileViewLoad({
      stat: { name: 'a.mp4', kind: 'video' },
      dirEntries: [
        { name: 'a.mp4', path: 'C:\\vids\\a.mp4', kind: 'video', isDir: false, size: 1 },
        { name: 'b.mp4', path: 'C:\\vids\\b.mp4', kind: 'video', isDir: false, size: 2 },
      ],
    });

    render(
      <FileViewer url="urchin://file-viewer/?path=C%3A%5Cvids%5Ca.mp4" onNavigate={onNavigate} />,
    );
    await waitFor(() => {
      expect(document.querySelector('video')).not.toBeNull();
    });

    const video = document.querySelector('video')!;
    video.currentTime = 30;
    video.volume = 0.5;

    // → 前进 10 秒；← 后退 10 秒（视频模式不触发文件切换）
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(video.currentTime).toBe(40);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(video.currentTime).toBe(30);
    expect(onNavigate).not.toHaveBeenCalled();

    // ↑ 音量 +0.02；↓ 音量 -0.02（每按键 2%）
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(video.volume).toBeCloseTo(0.52);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(video.volume).toBeCloseTo(0.5);
    // 精简音量浮层同步展示（百分比文字）
    expect(document.body.textContent).toContain('50%');
  });

  it('should navigate via arrow keys', async () => {
    const onNavigate = vi.fn();
    mockFileViewLoad({
      stat: { name: 'b.png', kind: 'image' },
      dirEntries: [
        { name: 'a.png', path: 'C:\\pics\\a.png', kind: 'image', isDir: false, size: 1 },
        { name: 'b.png', path: 'C:\\pics\\b.png', kind: 'image', isDir: false, size: 3 },
      ],
    });

    render(
      <FileViewer url="urchin://file-viewer/?path=C%3A%5Cpics%5Cb.png" onNavigate={onNavigate} />,
    );
    await waitFor(() => {
      expect(screen.getByText('2/2')).toBeDefined();
    });

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(onNavigate).toHaveBeenCalledWith(
      'urchin://file-viewer/?path=' + encodeURIComponent('C:\\pics\\a.png'),
    );
  });

  it('should show too-large notice without rendering content', async () => {
    mockFileViewLoad({ stat: { name: 'big.txt', size: 100000000, kind: 'text' } });
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'file.stat') {
        return Promise.resolve({ name: 'big.txt', size: 100000000, ext: 'txt', kind: 'text' });
      }
      if (channel === 'file.read') {
        return Promise.reject(Object.assign(new Error('too large'), { code: 'FILE_TOO_LARGE' }));
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<FileViewer url="urchin://file-viewer/?path=C%3A%5Cbig.txt" />);

    await waitFor(() => {
      expect(screen.getByText(/文件过大/)).toBeDefined();
    });
  });

  it('should show error when stat fails', async () => {
    mockInvoke.mockRejectedValue({ code: 'NOT_FOUND', message: 'File not found' });

    render(<FileViewer url="urchin://file-viewer/?path=C%3A%5Cmissing.txt" />);

    await waitFor(() => {
      expect(screen.getByText(/无法打开文件/)).toBeDefined();
    });
  });
});

// ── 组件测试 · 目录浏览模式 ──

describe('FileViewer · 目录浏览', () => {
  it('should render folder grid with folders first and viewable files', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'file.dir') {
        return Promise.resolve({
          entries: [
            { name: 'sub', path: 'C:\\pics\\sub', kind: 'binary', isDir: true, size: 0 },
            { name: 'a.png', path: 'C:\\pics\\a.png', kind: 'image', isDir: false, size: 2048 },
            { name: 'b.mp4', path: 'C:\\pics\\b.mp4', kind: 'video', isDir: false, size: 1048576 },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<FileViewer url="urchin://file-viewer/?dir=C%3A%5Cpics" />);

    await waitFor(() => {
      expect(screen.getByText('C:\\pics')).toBeDefined();
      expect(screen.getByText('sub')).toBeDefined();
      expect(screen.getByText('a.png')).toBeDefined();
      expect(screen.getByText('b.mp4')).toBeDefined();
    });
    // 文件大小格式化显示
    expect(screen.getByText('2.00 KB')).toBeDefined();
  });

  it('should navigate into subfolder on folder click', async () => {
    const onNavigate = vi.fn();
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'file.dir') {
        return Promise.resolve({
          entries: [{ name: 'sub', path: 'C:\\pics\\sub', kind: 'binary', isDir: true, size: 0 }],
        });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<FileViewer url="urchin://file-viewer/?dir=C%3A%5Cpics" onNavigate={onNavigate} />);
    await waitFor(() => {
      fireEvent.click(screen.getByText('sub'));
    });
    expect(onNavigate).toHaveBeenCalledWith(
      'urchin://file-viewer/?dir=' + encodeURIComponent('C:\\pics\\sub'),
    );
  });

  it('should preview file on file click', async () => {
    const onNavigate = vi.fn();
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'file.dir') {
        return Promise.resolve({
          entries: [
            { name: 'a.png', path: 'C:\\pics\\a.png', kind: 'image', isDir: false, size: 1 },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<FileViewer url="urchin://file-viewer/?dir=C%3A%5Cpics" onNavigate={onNavigate} />);
    await waitFor(() => {
      fireEvent.click(screen.getByText('a.png'));
    });
    expect(onNavigate).toHaveBeenCalledWith(
      'urchin://file-viewer/?path=' + encodeURIComponent('C:\\pics\\a.png'),
    );
  });

  it('should show empty hint and hide up button at drive root', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'file.dir') {
        return Promise.resolve({ entries: [] });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<FileViewer url="urchin://file-viewer/?dir=C%3A%5C" />);

    await waitFor(() => {
      expect(screen.getByText('此文件夹为空')).toBeDefined();
    });
    // 盘符根无上一级，返回按钮禁用
    expect(screen.getByLabelText('返回上一级')).toHaveProperty('disabled', true);
  });

  it('should show error when directory load fails', async () => {
    mockInvoke.mockRejectedValue({ code: 'NOT_FOUND', message: 'nope' });

    render(<FileViewer url="urchin://file-viewer/?dir=C%3A%5Cmissing" />);

    await waitFor(() => {
      expect(screen.getByText(/无法打开文件夹/)).toBeDefined();
    });
  });
});
