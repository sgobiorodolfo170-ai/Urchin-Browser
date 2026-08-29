/**
 * 本地文件文本预览策略（read-plan）
 *
 * 职责：按 kind 与文件大小决定 file.read 的读取上限与渲染形态，
 * 是「分级预览」的唯一决策点（纯函数，无 IO，便于单测）。
 *
 * 依据（2026-08-30 Windows 实测，单跑指示值）：
 * - 渲染耗时：<pre> 纯文本 4.9MB ≈0.35s；JSON 4.9MB ≈2.9s；
 *   Markdown ≈1.8s/MB 线性（4.8MB → 8.9s，冻结级体验）
 * - file.read 内存峰值恒为 maxBytes（有界读取）；全管线内存乘数 ≈3-4× 读取量
 *
 * 策略：
 * - ≤ 全量阈值：按阈值上限读取（实际整文件），按原生形态渲染
 *   （markdown 走 marked、json 美化缩进）
 * - > 全量阈值：只读头部 HEAD_PREVIEW_BYTES，降级纯文本 <pre> + 截断横幅——
 *   markdown/json 的解析对超大内容要么秒级阻塞要么对截断内容必然失败，一律跳过
 */
import type { FileKind } from '@urchin/ipc-contract';

/** 文本家族 kind（file.read 的服务对象）。 */
export type TextKind = 'markdown' | 'json' | 'text';

/** 分类型全量渲染阈值（字节）。markdown 阈值更严：解析耗时 ≈1.8s/MB，2MB 已达 3.8s。 */
export const FULL_RENDER_LIMIT: Readonly<Record<TextKind, number>> = {
  markdown: 2 * 1024 * 1024,
  json: 5 * 1024 * 1024,
  text: 5 * 1024 * 1024,
};

/** 截断预览头部大小：实测 2MB <pre> 渲染 <0.5s，全管线内存 ≈8MB 且与文件大小无关。 */
export const HEAD_PREVIEW_BYTES = 2 * 1024 * 1024;

/** 一次文本读取的执行计划。 */
export interface ReadPlan {
  /** 传给 file.read 的 maxBytes。 */
  readonly maxBytes: number;
  /** 渲染形态：超阈值时一律降级纯文本（renderAs !== kind 即「降级」）。 */
  readonly renderAs: TextKind;
}

/** 是否为走 file.read 文本渲染的 kind（其余 kind 走媒体/PDF 原生渲染）。 */
export function isTextKind(kind: FileKind): kind is TextKind {
  return kind === 'markdown' || kind === 'json' || kind === 'text';
}

/**
 * 计算文本预览执行计划。
 *
 * @param kind 文件类型（必须是 TextKind）
 * @param totalSize 文件大小（字节，来自 file.stat）
 * @returns 读取上限与渲染形态
 */
export function planTextRender(kind: TextKind, totalSize: number): ReadPlan {
  const limit = FULL_RENDER_LIMIT[kind];
  if (totalSize <= limit) return { maxBytes: limit, renderAs: kind };
  return { maxBytes: HEAD_PREVIEW_BYTES, renderAs: 'text' };
}
