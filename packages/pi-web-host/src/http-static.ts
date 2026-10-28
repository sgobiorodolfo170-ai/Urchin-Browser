/**
 * pi 阶段 2 托管服务 · HTTP 静态文件服务
 *
 * 为自研前端（apps/pi-web 构建产物）提供静态托管，M2A 最小实现：
 * - 路径遍历防护（解析后必须仍位于 wwwDir 内）
 * - 目录请求回退 index.html；未知扩展名按 octet-stream
 * - 文件读取失败（不存在/越权）统一 404，不暴露内部路径
 *
 * 打包态：wwwDir 可能位于 app.asar 内（Electron utilityProcess 可读 asar），
 * fs.readFile 即可，无需额外处理。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { MIME_TYPES } from './types';

export interface StaticHandlerOptions {
  readonly wwwDir: string;
}

/**
 * 返回静态请求处理器。调用方（server.ts）应先完成鉴权，再进入本处理器。
 */
export function createStaticHandler(options: StaticHandlerOptions): StaticHandler {
  return new StaticHandler(options.wwwDir);
}

export class StaticHandler {
  private readonly wwwDir: string;

  constructor(wwwDir: string) {
    // 规范化根目录并去除末尾分隔符，供前缀校验用
    this.wwwDir = normalize(resolve(wwwDir));
  }

  /** HTTP 请求入口：目录回退 index.html，越界/文件缺失 → 404 */
  async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlPath = (req.url?.split('?')[0] ?? '/').replace(/\\/g, '/');
    let filePath: string;
    try {
      filePath = this.resolveWithinRoot(urlPath);
    } catch {
      this.writeText(res, 404, 'Not Found');
      return;
    }

    // 目录 → index.html
    try {
      const st = await stat(filePath);
      if (st.isDirectory()) {
        filePath = join(filePath, 'index.html');
      }
    } catch {
      this.writeText(res, 404, 'Not Found');
      return;
    }

    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(filePath);
    } catch {
      this.writeText(res, 404, 'Not Found');
      return;
    }
    if (!st.isFile()) {
      this.writeText(res, 404, 'Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  }

  /** 解析 + 越界防护：仅允许 wwwDir 内的绝对路径 */
  private resolveWithinRoot(urlPath: string): string {
    const normalizedRequest = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const candidate = resolve(this.wwwDir, '.' + sep + normalizedRequest);
    if (!candidate.startsWith(this.wwwDir + sep) && candidate !== this.wwwDir) {
      throw new Error('path traversal blocked');
    }
    return candidate;
  }

  private writeText(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(body);
  }
}
