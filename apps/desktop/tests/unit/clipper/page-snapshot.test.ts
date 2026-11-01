/**
 * 页面快照脚本：清理非正文、开放 Shadow DOM、信号采集、frame 合并。
 */
import { describe, it, expect } from 'vitest';
import {
  buildPageSnapshotScript,
  capturePageSnapshot,
  type SnapshotFrameLike,
} from '../../../src/main/clipper/page-snapshot';

interface Raw {
  ok: boolean;
  html: string;
  title: string;
  textLength: number;
  hasOpenShadow: boolean;
  userSelectNone: boolean;
  imageCount: number;
}

async function runScript(): Promise<Raw> {
  const script = buildPageSnapshotScript(false);
  return (await window.eval(script)) as Raw;
}

describe('clipper page snapshot', () => {
  it('should strip scripts/styles and keep article/open shadow DOM', async () => {
    document.title = '页面标题';
    document.body.innerHTML = '<article><h1>Hello</h1><p>正文</p><script>1</script></article>';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>shadow text</p>';

    const raw = await runScript();
    expect(raw.ok).toBe(true);
    expect(raw.html).toContain('<h1>Hello</h1>');
    expect(raw.html).not.toContain('<script');
    expect(raw.html).toContain('shadow text');
    expect(raw.hasOpenShadow).toBe(true);
    expect(raw.title).toBe('页面标题');
  });

  it('should merge frames with enough text and ignore empty frames', async () => {
    const mainContents = {
      executeJavaScript: <T>() =>
        Promise.resolve({
          ok: true,
          url: 'https://example.com',
          title: 'main',
          html: '<body><p>main</p></body>',
          selectionHtml: '',
          selectionText: '',
          textLength: 500,
          imageCount: 1,
          frameCount: 2,
        } as unknown as T),
      getURL: () => 'https://example.com',
    };
    const frames: SnapshotFrameLike[] = [
      {
        executeJavaScript: <T>() =>
          Promise.resolve({
            ok: true,
            url: 'https://frame.test',
            title: 'frame',
            html: '<p>frame content</p>',
            textLength: 120,
          } as unknown as T),
      },
      {
        executeJavaScript: <T>() =>
          Promise.resolve({
            ok: true,
            url: 'https://ad.test',
            title: 'ad',
            html: '<p>ad</p>',
            textLength: 5,
          } as unknown as T),
      },
    ];
    const snapshot = await capturePageSnapshot(mainContents, {
      loadLazy: false,
      frameList: frames,
    });
    expect(snapshot.html).toContain('main');
    expect(snapshot.html).toContain('frame content');
    expect(snapshot.html).not.toContain('<p>ad</p>');
    expect(snapshot.signals.frameCount).toBe(2);
  });
});
