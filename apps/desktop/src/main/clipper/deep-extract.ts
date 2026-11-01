/**
 * M26 剪藏 · 深度抽取兜底
 *
 * 职责：
 * 1. 收集 tab 的子 frame（含跨域 iframe）供 page-snapshot 逐帧执行脚本。
 * 2. 通过 CDP 补抽闭 Shadow DOM（页面脚本无法访问 closed root）。
 *
 * 设计理由：
 * - frame 遍历用 Electron 官方 WebFrameMain API，不需要 CDP；
 * - closed shadow 只在主 frame 文本很少/存在 canvas 时尝试，减少调试器占用与开销；
 * - 若 DevTools 面板已占用 debugger，命令失败即降级，不影响普通剪藏。
 */
import type { ClipperPageSignals } from '@urchin/ipc-contract';
import type { SnapshotFrameLike } from './page-snapshot';

/** CDP 依赖的最小接口（真实 Electron debugger / 单测 mock 均满足） */
export interface CdpDebuggerLike {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
}

/** WebContents 上深度抽取需要的结构（可选字段避免影响既有接口） */
export interface DeepExtractWebContents {
  readonly debugger?: CdpDebuggerLike;
  readonly mainFrame?: {
    readonly framesInSubtree?: readonly SnapshotFrameLike[];
    readonly frames?: readonly SnapshotFrameLike[];
  };
}

/** CDP 协议版本：与仓库 devtools 模块保持一致 */
const CDP_PROTOCOL_VERSION = '1.3';
/** 最多补抽的 closed shadow 数量 */
const MAX_CLOSED_SHADOW_ROOTS = 30;

interface CdpNode {
  readonly nodeId?: number;
  readonly nodeType?: number;
  readonly nodeName?: string;
  readonly nodeValue?: string;
  readonly attributes?: readonly string[];
  readonly shadowRootType?: string;
  readonly shadowRoots?: readonly CdpNode[];
  readonly children?: readonly CdpNode[];
  readonly contentDocument?: CdpNode;
}

interface CdpDocumentResult {
  readonly root?: CdpNode;
}

/** HTML void 元素：序列化时不输出结束标签 */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

/**
 * 收集所有子 frame（不包含 mainFrame）。
 *
 * framesInSubtree 包含自身，按 Electron 文档需排除 mainFrame；兼容只提供
 * frames 的旧接口。
 */
export function collectSubFrames(
  webContents: DeepExtractWebContents,
): readonly SnapshotFrameLike[] {
  const mainFrame = webContents.mainFrame;
  if (!mainFrame) return [];
  const subtree = mainFrame.framesInSubtree;
  if (subtree && subtree.length > 0) {
    return subtree.filter((frame) => frame !== mainFrame);
  }
  return mainFrame.frames ?? [];
}

/** 是否值得尝试 closed shadow 补抽：文本很少或存在 canvas 时 */
export function shouldTryClosedShadow(signals: ClipperPageSignals): boolean {
  return signals.textLength < 2_000 || signals.hasCanvas;
}

/**
 * 把 CDP DOM.getDocument(pierce:true) 的节点树序列化为 HTML。
 *
 * 不使用 DOM.getOuterHTML(shadowRoot)：不同 Electron/Chromium 版本对 shadow root
 * 节点返回 `<template shadowrootmode=...>` 或空串，Defuddle 会把 template 丢弃。
 * 这里直接序列化 shadow root 的 children，得到可用于正文抽取的真实文本节点。
 */
function serializeCdpNode(node: CdpNode): string {
  if (node.nodeType === 3) return escapeHtml(node.nodeValue ?? '');
  if (node.nodeType === 8 || node.nodeType === 10) return '';
  if (node.nodeType !== 1) {
    return (node.children ?? []).map(serializeCdpNode).join('');
  }
  const name = (node.nodeName ?? '').toLowerCase();
  if (!name) return '';
  const attrs: string[] = [];
  const rawAttrs = node.attributes ?? [];
  for (let index = 0; index + 1 < rawAttrs.length; index += 2) {
    attrs.push(` ${rawAttrs[index]}="${escapeAttr(rawAttrs[index + 1] ?? '')}"`);
  }
  const open = `<${name}${attrs.join('')}>`;
  if (VOID_ELEMENTS.has(name)) return open;
  const children = (node.children ?? []).map(serializeCdpNode).join('');
  return `${open}${children}</${name}>`;
}

/** 递归遍历 CDP 节点树，收集 shadowRoots */
function collectShadowRoots(node: CdpNode, out: CdpNode[]): void {
  if (out.length >= MAX_CLOSED_SHADOW_ROOTS) return;
  for (const root of node.shadowRoots ?? []) {
    out.push(root);
    collectShadowRoots(root, out);
    if (out.length >= MAX_CLOSED_SHADOW_ROOTS) return;
  }
  for (const child of node.children ?? []) {
    collectShadowRoots(child, out);
    if (out.length >= MAX_CLOSED_SHADOW_ROOTS) return;
  }
  const content = node.contentDocument;
  if (content) collectShadowRoots(content, out);
}

/**
 * 通过 CDP 抽取 closed shadow DOM 的内容。
 *
 * 返回值是包裹后的 section 片段，可直接拼到主文档尾部交给 Defuddle。
 * 调试器不可用/已占用/命令失败时返回空串（调用方继续使用主快照）。
 */
export async function collectClosedShadowHtml(
  webContents: DeepExtractWebContents,
): Promise<string> {
  const dbg = webContents.debugger;
  if (!dbg) return '';

  const alreadyAttached = dbg.isAttached();
  let attachedByUs = false;
  try {
    if (!alreadyAttached) {
      dbg.attach(CDP_PROTOCOL_VERSION);
      attachedByUs = true;
    }
    const doc = (await dbg.sendCommand('DOM.getDocument', {
      depth: -1,
      pierce: true,
    })) as CdpDocumentResult;
    if (!doc.root) return '';

    const roots: CdpNode[] = [];
    collectShadowRoots(doc.root, roots);
    if (roots.length === 0) return '';

    const chunks: string[] = [];
    for (const root of roots) {
      const body = (root.children ?? []).map(serializeCdpNode).join('');
      if (!body.trim()) continue;
      const type = root.shadowRootType?.trim() ?? 'closed';
      const label = type.length > 0 ? type : 'closed';
      chunks.push(`<section data-urchin-closed-shadow="${escapeAttr(label)}">${body}</section>`);
    }
    return chunks.join('\n');
  } catch {
    return '';
  } finally {
    if (attachedByUs) {
      try {
        dbg.detach();
      } catch {
        // detach 失败不影响剪藏
      }
    }
  }
}
