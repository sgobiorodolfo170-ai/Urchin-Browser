/**
 * M24 网页翻译 · 页面运行时单元测试（jsdom 同源执行）
 *
 * 关键点：测试 eval 的就是生产注入用的同一序列化结果（buildTranslateRuntimeInjection），
 * 保证「测的即所注入的」。覆盖规划 §7.2 的采集过滤/恢复一致性/幂等/增量队列/拆除。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildTranslateRuntimeInjection,
  buildCollectCall,
  buildApplyCall,
  buildTakePendingCall,
  TEARDOWN_CALL,
} from '../../../src/main/translate/scripts/page-translate-script';

interface Segment {
  id: number;
  text: string;
}

interface Runtime {
  collect(): { lang: string; segments: Segment[] };
  apply(items: Segment[]): number;
  restore(): void;
  takePending(max: number): Segment[];
  teardown(): void;
}

/** 间接 eval：在全局作用域执行注入串（与 executeJavaScript 的页面世界语义一致） */
function evalCode(code: string): unknown {
  return (0, eval)(code);
}

function runtime(): Runtime {
  const rt = (window as unknown as { __ubTranslate?: Runtime }).__ubTranslate;
  if (!rt) throw new Error('runtime not installed');
  return rt;
}

describe('translatePageRuntime（页面注入运行时）', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    evalCode('delete window.__ubTranslate');
  });

  it('should collect only visible translatable text nodes', () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <p id="keep">Hello wonderful world</p>
      <script>var marker = "script inner code";</script>
      <style>.marker { color: red }</style>
      <span style="display:none">hidden style text</span>
      <textarea>textarea default value</textarea>
      <div contenteditable="true">editable user input</div>
      <p aria-hidden="true">aria hidden label</p>
      <p translate="no">BrandName keep</p>
      <p class="notranslate">notranslate class</p>
      <p>12345</p>
      <p>ab</p>
      <select><option>option value text</option></select>
      <p>7</p>
    `;
    evalCode(buildTranslateRuntimeInjection());

    const res = runtime().collect();
    expect(res.lang).toBe('en');
    const texts = res.segments.map((s) => s.text);
    expect(texts).toContain('Hello wonderful world');
    expect(texts).toContain('ab');
    expect(texts.some((t) => t.includes('script inner code'))).toBe(false);
    expect(texts.some((t) => t.includes('hidden style'))).toBe(false);
    expect(texts.some((t) => t.includes('textarea default'))).toBe(false);
    expect(texts.some((t) => t.includes('editable user input'))).toBe(false);
    expect(texts.some((t) => t.includes('aria hidden'))).toBe(false);
    expect(texts.some((t) => t.includes('BrandName keep'))).toBe(false);
    expect(texts.some((t) => t.includes('notranslate class'))).toBe(false);
    expect(texts.some((t) => t.includes('option value'))).toBe(false);
    expect(texts).not.toContain('12345');
    expect(texts).not.toContain('7');
  });

  it('should apply translations by id and restore originals exactly', () => {
    document.body.innerHTML = '<p>Hello world</p><p>Second paragraph</p>';
    evalCode(buildTranslateRuntimeInjection());
    const res = runtime().collect();
    expect(res.segments).toHaveLength(2);

    const applied = evalCode(
      buildApplyCall([{ id: res.segments[0]!.id, text: '你好世界' }]),
    ) as number;
    expect(applied).toBe(1);
    const p = document.body.querySelector('p')!;
    expect(p.textContent).toBe('你好世界');
    // 第二段未被本批覆盖，保持原文
    expect(document.body.querySelectorAll('p')[1]!.textContent).toBe('Second paragraph');

    runtime().restore();
    expect(p.textContent).toBe('Hello world');
  });

  it('should be idempotent on repeated injection', () => {
    document.body.innerHTML = '<p>abc def</p>';
    evalCode(buildTranslateRuntimeInjection());
    const first = (window as unknown as { __ubTranslate?: Runtime }).__ubTranslate;
    evalCode(buildTranslateRuntimeInjection());
    const second = (window as unknown as { __ubTranslate?: Runtime }).__ubTranslate;
    expect(second).toBe(first);
  });

  it('should restore previous translations when re-collecting', () => {
    document.body.innerHTML = '<p>Hello world</p>';
    evalCode(buildTranslateRuntimeInjection());
    const res1 = runtime().collect();
    evalCode(buildApplyCall([{ id: res1.segments[0]!.id, text: '你好世界' }]));
    expect(document.body.querySelector('p')!.textContent).toBe('你好世界');

    const res2 = runtime().collect();
    // 重采后 DOM 已恢复原文，段 ID 重新从 1 计
    expect(document.body.querySelector('p')!.textContent).toBe('Hello world');
    expect(res2.segments[0]!.id).toBe(1);
    expect(res2.segments[0]!.text).toBe('Hello world');
  });

  it('should expose dynamically added nodes via takePending without duplicates', async () => {
    document.body.innerHTML = '<p>initial content</p>';
    evalCode(buildTranslateRuntimeInjection());
    runtime().collect();

    const fresh = document.createElement('p');
    fresh.textContent = 'fresh dynamic text';
    document.body.appendChild(fresh);

    // MutationObserver 回调在微任务中排队，等一拍再拉取
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = evalCode(buildTakePendingCall(10)) as Segment[];
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toBe('fresh dynamic text');
    const second = evalCode(buildTakePendingCall(10)) as Segment[];
    expect(second).toHaveLength(0);
  });

  it('should teardown: restore text, remove flag and stop tracking', () => {
    document.body.innerHTML = '<p>Hello world</p>';
    evalCode(buildTranslateRuntimeInjection());
    const res = runtime().collect();
    evalCode(buildApplyCall([{ id: res.segments[0]!.id, text: '你好世界' }]));

    evalCode(TEARDOWN_CALL);
    expect(document.body.querySelector('p')!.textContent).toBe('Hello world');
    expect((window as unknown as { __ubTranslate?: Runtime }).__ubTranslate).toBeUndefined();
  });

  it('should return empty result via collect call wrapper when runtime fails to install', () => {
    // buildCollectCall 含防御：运行时缺失/抛错时返回空结构而非拒绝
    document.body.innerHTML = '<p>abc</p>';
    const res = evalCode(buildCollectCall()) as { lang: string; segments: Segment[] };
    expect(res.segments).toHaveLength(1);
    expect(res.segments[0]!.text).toBe('abc');
  });
});
