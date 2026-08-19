/**
 * urchin://file-resource 协议逻辑单元测试
 *
 * 验证（parseResourcePath + planLocalFileResponse 纯函数）：
 * 1. parseResourcePath：编码路径解码 / 空路径 / 畸形 % 编码
 * 2. planLocalFileResponse：
 *   - Referer 非 urchin:// → 403（防外部网页跨源盗读本地文件）
 *   - 无 Range → 200 + Content-Length/Accept-Ranges
 *   - bytes=start-end / bytes=start- → 206 + Content-Range
 *   - 非法 Range / start 越界 → 416
 *
 * 注：流式 body（createReadStream）为 Electron 协议 IO，jsdom 环境不做
 * 单元测试（与项目「IO 经注入/纯函数分层」测试约定一致）。
 */
import { describe, it, expect } from 'vitest';
import { parseResourcePath, planLocalFileResponse } from '../../src/main/protocol/index';

describe('parseResourcePath', () => {
  it('should decode percent-encoded absolute path', () => {
    const url = new URL(
      'urchin://file-resource/C%3A%5CUsers%5C%E5%A3%81%E7%BA%B8%5C%E8%A7%86%E9%A2%91.mp4',
    );
    expect(parseResourcePath(url)).toBe('C:\\Users\\壁纸\\视频.mp4');
  });

  it('should decode forward-slash paths', () => {
    const url = new URL('urchin://file-resource/C%3A%2Fdocs%2Fa.pdf');
    expect(parseResourcePath(url)).toBe('C:/docs/a.pdf');
  });

  it('should return null for empty path', () => {
    const url = new URL('urchin://file-resource/');
    expect(parseResourcePath(url)).toBeNull();
  });

  it('should return null for malformed percent-encoding', () => {
    const url = new URL('urchin://file-resource/%E0%A4%A');
    expect(parseResourcePath(url)).toBeNull();
  });
});

describe('planLocalFileResponse', () => {
  it('should return 403 when referer is a remote web page', () => {
    const plan = planLocalFileResponse('https://evil.com', null, 100, 'text/plain');
    expect(plan.status).toBe(403);
    expect(plan.streamRange).toBeNull();
  });

  it('should reject any http(s) referer that is not localhost', () => {
    expect(planLocalFileResponse('http://attacker.example/x', null, 100, 'a/b').status).toBe(403);
    expect(planLocalFileResponse('https://a.com', null, 100, 'a/b').status).toBe(403);
  });

  it('should allow urchin:// referer', () => {
    const plan = planLocalFileResponse('urchin://file-viewer/?path=x', null, 100, 'text/plain');
    expect(plan.status).not.toBe(403);
  });

  it('should allow localhost dev-mode referer', () => {
    expect(planLocalFileResponse('http://localhost:5173/', null, 100, 'a/b').status).not.toBe(403);
    expect(planLocalFileResponse('http://127.0.0.1:5173/x', null, 100, 'a/b').status).not.toBe(403);
  });

  it('should allow empty referer (media subresource requests may omit it)', () => {
    const plan = planLocalFileResponse('', null, 100, 'video/mp4');
    expect(plan.status).toBe(200);
  });

  it('should allow file:// production main window referer', () => {
    expect(
      planLocalFileResponse('file:///C:/app/dist/index.html', null, 100, 'a/b').status,
    ).not.toBe(403);
  });

  it('should return 200 with full length when no Range', () => {
    const plan = planLocalFileResponse('urchin://file-viewer/', null, 2048, 'image/png');
    expect(plan.status).toBe(200);
    expect(plan.headers).toMatchObject({
      'Content-Type': 'image/png',
      'Accept-Ranges': 'bytes',
      'Content-Length': '2048',
    });
    expect(plan.streamRange).toBeNull();
  });

  it('should return 206 partial content for bytes=start-end', () => {
    const plan = planLocalFileResponse('urchin://file-viewer/', 'bytes=100-199', 1000, 'video/mp4');
    expect(plan.status).toBe(206);
    expect(plan.streamRange).toEqual({ start: 100, end: 199 });
    expect(plan.headers).toMatchObject({
      'Content-Range': 'bytes 100-199/1000',
      'Content-Length': '100',
    });
  });

  it('should clamp end beyond file size', () => {
    const plan = planLocalFileResponse(
      'urchin://file-viewer/',
      'bytes=900-9999',
      1000,
      'video/mp4',
    );
    expect(plan.status).toBe(206);
    expect(plan.streamRange).toEqual({ start: 900, end: 999 });
    expect(plan.headers['Content-Range']).toBe('bytes 900-999/1000');
  });

  it('should return 416 for start beyond file size', () => {
    const plan = planLocalFileResponse('urchin://file-viewer/', 'bytes=1000-', 1000, 'video/mp4');
    expect(plan.status).toBe(416);
    expect(plan.headers['Content-Range']).toBe('bytes */1000');
  });

  it('should return 416 for malformed Range header', () => {
    const plan = planLocalFileResponse('urchin://file-viewer/', 'bytes=abc', 1000, 'video/mp4');
    expect(plan.status).toBe(416);
  });
});
