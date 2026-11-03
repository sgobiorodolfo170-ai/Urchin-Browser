/**
 * 中转区 · OS 文件拖入路径解析单测
 *
 * 背景：Electron 32+ 移除了 File.path，必须经 preload 的 webUtils.getPathForFile。
 * 本测试锁定「桥接优先 → 旧 File.path 回退 → 取不到则跳过」的行为，防止回归到
 * 「拖入文件后中转区无反应」。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDroppedFilePath } from '../../src/renderer/transit/file-path';
import { collectDroppedFiles } from '../../src/renderer/transit/TransitPanel';

type PathBridge = (file: File) => string;

function installPathBridge(pathForFile?: PathBridge): void {
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    writable: true,
    value: pathForFile ? { pathForFile } : {},
  });
}

function makeFile(name: string, type = '', content = 'content'): File {
  return new File([content], name, { type });
}

function makeTransfer(files: File[]): DataTransfer {
  return { files } as unknown as DataTransfer;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'urchin');
});

describe('resolveDroppedFilePath', () => {
  it('should use preload bridge path on Electron 32+', () => {
    installPathBridge(() => 'C:\\Desktop\\report.pdf');
    expect(resolveDroppedFilePath(makeFile('report.pdf'))).toBe('C:\\Desktop\\report.pdf');
  });

  it('should prefer bridge path over legacy File.path', () => {
    const file = makeFile('a.txt');
    Object.defineProperty(file, 'path', { configurable: true, value: 'C:\\legacy\\a.txt' });
    installPathBridge(() => 'C:\\bridge\\a.txt');
    expect(resolveDroppedFilePath(file)).toBe('C:\\bridge\\a.txt');
  });

  it('should fall back to legacy File.path when bridge returns empty', () => {
    const file = makeFile('a.txt');
    Object.defineProperty(file, 'path', { configurable: true, value: 'C:\\legacy\\a.txt' });
    installPathBridge(() => '');
    expect(resolveDroppedFilePath(file)).toBe('C:\\legacy\\a.txt');
  });

  it('should return empty string when no path is available', () => {
    installPathBridge();
    expect(resolveDroppedFilePath(makeFile('a.txt'))).toBe('');
  });

  it('should swallow bridge errors and fall back to empty string', () => {
    installPathBridge(() => {
      throw new Error('not a File');
    });
    expect(resolveDroppedFilePath(makeFile('a.txt'))).toBe('');
  });
});

describe('collectDroppedFiles', () => {
  it('should return empty array when transfer has no files', () => {
    installPathBridge(() => 'C:\\x');
    expect(collectDroppedFiles(makeTransfer([]))).toEqual([]);
  });

  it('should map dropped files into transit inputs with resolved paths', () => {
    installPathBridge((file) => `C:\\drop\\${file.name}`);
    const pdf = makeFile('a.pdf', 'application/pdf', 'abc');
    const txt = makeFile('b.txt');
    const result = collectDroppedFiles(makeTransfer([pdf, txt]));

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      kind: 'file',
      title: 'a.pdf',
      filePath: 'C:\\drop\\a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
      sourceApp: 'desktop',
    });
    expect(result[1]).toMatchObject({
      kind: 'file',
      title: 'b.txt',
      filePath: 'C:\\drop\\b.txt',
      sourceApp: 'desktop',
    });
  });

  it('should skip files whose path cannot be resolved', () => {
    installPathBridge((file) => (file.name === 'ok.txt' ? 'C:\\drop\\ok.txt' : ''));
    const result = collectDroppedFiles(makeTransfer([makeFile('ok.txt'), makeFile('bad.txt')]));
    expect(result.map((item) => item.title)).toEqual(['ok.txt']);
  });
});
