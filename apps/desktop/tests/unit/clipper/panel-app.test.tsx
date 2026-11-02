/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- 测试 mock 与 DOM 断言 */
/**
 * 剪藏面板：加载配置/页面、格式切换、保存 Markdown/快照、OCR 占位禁用。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ClipperConfigRes, ClipperPageRes } from '@urchin/ipc-contract';

const extraction = {
  title: '测试标题',
  url: 'https://example.com/a',
  author: '作者',
  published: '',
  description: '',
  site: 'Example',
  domain: 'example.com',
  language: 'zh',
  words: 10,
  favicon: '',
  image: '',
  pageContentHtml: '<p>正文</p>',
  pageMarkdown: '正文',
  selectionMarkdown: '选中内容',
  contentMarkdown: '正文',
  usedSelection: false,
};

vi.mock('../../../src/renderer/clipper/extract', () => ({
  extractClipperContent: vi.fn(() => extraction),
}));

import { ClipperPanelApp } from '../../../src/renderer/clipper/clipper-panel-app';

const CONFIG: ClipperConfigRes = {
  theme: 'light',
  defaultFormat: 'markdown',
  cleanSnapshot: true,
  selectionPriority: true,
  loadLazyContent: false,
  localizeImages: false,
  noteNameFormat: '{{title}}',
  properties: 'title: {{title}}\nsource: {{url}}',
  content: '{{content}}',
  saveDirLabel: 'documents/clipper',
};

const PAGE: ClipperPageRes = {
  url: 'https://example.com/a',
  title: '测试标题',
  html: '<p>正文</p>',
  selectionHtml: '<p>选中内容</p>',
  selectionText: '选中内容',
  signals: {
    copyBlocked: true,
    userSelectNone: false,
    hasCanvas: false,
    hasOpenShadow: false,
    hasClosedShadow: false,
    frameCount: 0,
    imageCount: 0,
    textLength: 10,
  },
};

const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'clipper.config') return CONFIG;
    if (channel === 'clipper.page') return PAGE;
    if (channel === 'clipper.listSubDirs') return { dirs: [] };
    if (channel === 'clipper.saveMarkdown') return { path: '/clipper/test.md' };
    if (channel === 'clipper.saveSnapshot') return { paths: ['/clipper/test.mhtml'], warnings: [] };
    if (channel === 'clipper.close') return { ok: true };
    if (channel === 'clipper.copy') return { ok: true };
    return {};
  });
  Object.defineProperty(window, 'urchin', {
    value: { invoke },
    writable: true,
    configurable: true,
  });
  window.history.replaceState({}, '', '/?view=clipper&tabId=1');
});

describe('ClipperPanelApp', () => {
  it('should load page and save Markdown', async () => {
    render(<ClipperPanelApp />);
    await screen.findByText('剪藏（Clipper）');
    expect(screen.getByLabelText('文件名')).toHaveValue('测试标题');
    // 页面属性字段展示中文名 + 原始 key
    expect(screen.getByText('标题')).toBeInTheDocument();
    expect(screen.getByText('来源链接')).toBeInTheDocument();
    expect(screen.getByLabelText('标题（title）')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'clipper.saveMarkdown',
        expect.objectContaining({
          noteName: '测试标题',
          markdown: expect.stringContaining('选中内容'),
        }),
      ),
    );
  });

  it('should switch to MHTML and save cleaned snapshot', async () => {
    render(<ClipperPanelApp />);
    await screen.findByText('剪藏（Clipper）');
    const format = screen.getByLabelText('保存格式');
    fireEvent.change(format, { target: { value: 'mhtml' } });
    expect(screen.getByLabelText('快照方式')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'clipper.saveSnapshot',
        expect.objectContaining({
          tabId: 1,
          format: 'mhtml',
          mode: 'clean',
          cleanedHtml: expect.stringContaining('<article>'),
        }),
      ),
    );
  });

  it('should render disabled OCR option', async () => {
    render(<ClipperPanelApp />);
    await screen.findByText('剪藏（Clipper）');
    const ocr = screen.getByRole('option', { name: 'OCR 文本（即将支持）' });
    expect(ocr).toBeDisabled();
  });
});
