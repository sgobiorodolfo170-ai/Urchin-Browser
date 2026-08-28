/**
 * pi 网页版 · UI 状态持久化端点（dev.67）
 *
 * 需求（用户）：pi 页中区与左右两区的分割线可自由拖动、折叠状态与左区项目
 * 手动排序在「项目关闭后下次打开」仍保留。pi 服务每次启动端口随机 → 页面
 * origin 随之改变 → localStorage / sessionStorage 均不可用于跨会话持久化
 *（dev.45 实证：clientId 每会话重置）。故由 Urchin 主进程提供
 * `urchin://pi-ui-state` 协议端点，落盘 `<userData>/pi/ui-state.json`：
 *
 * - GET `urchin://pi-ui-state` → 返回已存 JSON（无文件返回 {}）
 * - GET `urchin://pi-ui-state?a=set&lw=280&rw=320&lc=1&rc=0&po=<encoded JSON>`
 *   → 合并写入并返回 {ok:true}。采用查询参数写入而非 POST：自定义协议的
 *   fetch POST  body 支持在各 Electron 版本间表现不一，GET 参数链路最稳
 *   （与 urchin://zoom 同型；本端点仅限本机受信页面访问，无重放/缓存风险）。
 *
 * 安全：Referer 白名单（urchin:// 内部页 / localhost / 127.0.0.1 / file://，
 * 与 pi-pick-dir 同语义）——防远程网页篡改本地 UI 偏好；数值钳制 + 数组
 * 上限，防异常参数写坏状态文件。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createLogger } from '@urchin/logger';

const log = createLogger('pi-web-ui-state');

/** UI 状态协议 host（urchin://pi-ui-state） */
export const UI_STATE_HOST = 'pi-ui-state';

/** 持久化的 UI 状态形状（注入脚本与本模块的共同契约） */
export interface PiUiState {
  /** 左区宽（px） */
  lw?: number;
  /** 右区宽（px） */
  rw?: number;
  /** 左区折叠 */
  lc?: boolean;
  /** 右区折叠 */
  rc?: boolean;
  /** 项目手动排序（路径数组，未知路径追加其后） */
  po?: string[];
}

/** 宽度钳制范围（px）：太窄不可用，太宽挤压中区 */
const WIDTH_MIN = 180;
const WIDTH_MAX = 520;
/** 项目排序列表长度上限（防异常参数膨胀状态文件） */
const PO_MAX = 200;
/** 单个路径字符串长度上限 */
const PO_PATH_MAX = 500;

/** Referer 白名单：urchin:// 内部页、pi 页所在的本机回环、file:// */
function isTrustedUiStateReferer(referer: string): boolean {
  if (referer === '') return true;
  if (referer.startsWith('urchin://')) return true;
  if (referer.startsWith('file://')) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(referer);
}

/** 解析宽度查询参数（非法/越界返回 null） */
function parseWidth(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n));
}

/** 解析折叠开关参数（'1'/'0'，其他返回 null） */
function parseFlag(raw: string | null): boolean | null {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

/** 解析项目排序参数（JSON 字符串数组；非法返回 null） */
function parseOrder(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of arr) {
      if (typeof item !== 'string' || !item || item.length > PO_PATH_MAX) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
      if (out.length >= PO_MAX) break;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 从 set 查询参数解析增量状态（纯函数，可单测）。
 * 仅接受显式出现的参数；全部非法时返回空对象（等价无操作）。
 */
export function parseUiStateQuery(search: string): Partial<PiUiState> {
  const params = new URLSearchParams(search);
  const out: Partial<PiUiState> = {};
  const lw = parseWidth(params.get('lw'));
  if (lw !== null) out.lw = lw;
  const rw = parseWidth(params.get('rw'));
  if (rw !== null) out.rw = rw;
  const lc = parseFlag(params.get('lc'));
  if (lc !== null) out.lc = lc;
  const rc = parseFlag(params.get('rc'));
  if (rc !== null) out.rc = rc;
  const po = parseOrder(params.get('po'));
  if (po !== null) out.po = po;
  return out;
}

/** 读状态文件（缺失/损坏返回 {}，纯函数式封装便于单测注入） */
export function readUiStateFile(file: string): PiUiState {
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/** 合并写入状态文件（异步 fs——保持响应构建函数为真异步，目录不存在则创建） */
async function writeUiStateFile(file: string, state: PiUiState): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state), 'utf-8');
}

/**
 * 构建 pi-ui-state 协议响应（纯函数式入口，可单测）。
 *
 * @param referer 请求 Referer（白名单校验，防远程页面篡改）
 * @param url 请求完整 URL（区分读 / a=set 写）
 * @param file 状态文件绝对路径
 */
export async function buildUiStateResponse(
  referer: string,
  url: string,
  file: string,
): Promise<Response> {
  const jsonHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };
  if (!isTrustedUiStateReferer(referer)) {
    log.warn('pi-ui-state denied', { referer });
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  }
  const parsed = new URL(url);
  const resolved = resolve(file);
  if (parsed.searchParams.get('a') === 'set') {
    try {
      const prev = readUiStateFile(resolved);
      const next: PiUiState = { ...prev, ...parseUiStateQuery(parsed.search) };
      await writeUiStateFile(resolved, next);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
    } catch (e) {
      log.error('pi-ui-state write failed', { error: String(e) });
      return new Response(JSON.stringify({ ok: false }), { status: 500, headers: jsonHeaders });
    }
  }
  return new Response(JSON.stringify(readUiStateFile(resolved)), {
    status: 200,
    headers: jsonHeaders,
  });
}
