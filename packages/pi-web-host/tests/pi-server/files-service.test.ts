import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  absoluteParent,
  desktopDirWire,
  FilesService,
  isAbsoluteWirePath,
  MACHINE_ROOT,
  MAX_PREVIEW_BYTES,
  normWirePath,
  workspacePath,
  wireToAbs,
} from '../../src/pi-server/files-service.js';
import * as remoteSsh from '../../src/pi-server/remote-ssh-service.js';
import type { ServerMessage } from '../../src/pi-server/protocol.js';

const roots: string[] = [];
const isWin = process.platform === 'win32';
const wireOf = (p: string) => p.split(sep).join('/');

function tempRoot(prefix = 'pi-files-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

interface Host {
  emit: (msg: ServerMessage) => void;
  isDisposed: () => boolean;
  getCwd: () => string;
  getActiveCwd: () => string;
  getLang?: () => string;
  getUploadMaxBytes?: () => number;
}

function makeService(cwd: string, extra: Partial<Host> = {}) {
  const seen: ServerMessage[] = [];
  const svc = new FilesService({
    emit: (m) => void seen.push(m),
    isDisposed: () => false,
    getCwd: () => cwd,
    getActiveCwd: () => cwd,
    ...extra,
  });
  const notices = (level?: 'info' | 'warning' | 'error') =>
    seen.filter(
      (m): m is Extract<ServerMessage, { type: 'notice' }> =>
        m.type === 'notice' && (level === undefined || m.level === level),
    );
  const files = () =>
    seen.filter((m): m is Extract<ServerMessage, { type: 'files' }> => m.type === 'files');
  return { svc, seen, notices, files };
}

function fakeSsh(overrides: Record<string, unknown> = {}) {
  return {
    sftpReaddir: vi.fn(() => Promise.resolve([])),
    sftpStat: vi.fn(() => Promise.resolve({ isFile: false, isDirectory: true, size: 0, mtime: 0 })),
    sftpReadFile: vi.fn(() => Promise.resolve({ data: Buffer.from(''), size: 0 })),
    sftpWriteFile: vi.fn(() => Promise.resolve(undefined)),
    sftpMkdirRecursive: vi.fn(() => Promise.resolve(undefined)),
    sftpRename: vi.fn(() => Promise.resolve(undefined)),
    sftpRemove: vi.fn(() => Promise.resolve(undefined)),
    sftpCopy: vi.fn(() => Promise.resolve(undefined)),
    execInWorkspace: vi.fn(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })),
    ...overrides,
  };
}

const REMOTE = 'ssh://tester@example.test/work';

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of roots.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => undefined,
    );
});

describe('wire path helpers', () => {
  it('should treat machine root, posix absolute, UNC and drive paths as absolute wires', () => {
    expect(isAbsoluteWirePath('@root')).toBe(true);
    expect(isAbsoluteWirePath('/etc/passwd')).toBe(true);
    expect(isAbsoluteWirePath('//host/share')).toBe(true);
    expect(isAbsoluteWirePath('a/b')).toBe(false);
    expect(isAbsoluteWirePath('')).toBe(false);
  });

  it('should only treat drive letters as absolute on win32', () => {
    expect(isAbsoluteWirePath('C:/Users/x')).toBe(isWin);
    expect(isAbsoluteWirePath('C:')).toBe(isWin);
    expect(isAbsoluteWirePath('\\\\host\\share')).toBe(true);
  });

  it('should strip trailing slashes but keep a bare root', () => {
    expect(normWirePath('/home/user/')).toBe('/home/user');
    expect(normWirePath('/')).toBe('/');
    expect(normWirePath('///')).toBe('/');
    expect(normWirePath('a/b')).toBe('a/b');
  });

  it('should walk parents up to the machine root', () => {
    expect(absoluteParent(MACHINE_ROOT)).toBeNull();
    expect(absoluteParent('')).toBeNull();
    expect(absoluteParent('/')).toBeNull();
    expect(absoluteParent('/home/user/project')).toBe('/home/user');
    expect(absoluteParent('/home')).toBe('/');
    expect(absoluteParent('C:/Users/test/project')).toBe('C:/Users/test');
    expect(absoluteParent('C:/Users')).toBe('C:');
    expect(absoluteParent('C:/')).toBe(MACHINE_ROOT);
    expect(absoluteParent('C:')).toBe(MACHINE_ROOT);
    expect(absoluteParent('relative')).toBeNull();
  });

  it('should uppercase a bare win32 drive and resolve posix wires', () => {
    if (isWin) {
      expect(wireToAbs('c:')).toBe('C:\\');
      expect(wireToAbs('c:/')).toBe('C:\\');
    }
    expect(wireToAbs('/tmp/x/')).toBe(resolve('/tmp/x'));
  });

  it('should resolve workspace-relative paths and reject escapes', () => {
    const root = tempRoot();
    const inside = workspacePath(root, 'sub/file.txt');
    expect(inside).not.toBeNull();
    expect(inside!.rel).toBe('sub/file.txt');
    expect(inside!.abs.toLowerCase().startsWith(root.toLowerCase())).toBe(true);
    expect(workspacePath(root, '../escape.txt')).toBeNull();
    expect(workspacePath(root, 'a/../../escape.txt')).toBeNull();
  });

  it('should reject cross-drive targets on win32', () => {
    if (!isWin) return;
    const root = tempRoot();
    expect(workspacePath(root, `${root.startsWith('C') ? 'D' : 'C'}:\\somewhere`)).toBeNull();
  });

  it('should return an existing desktop wire or an empty string', () => {
    const missing = `/${Date.now()}-no-such-home`;
    expect(desktopDirWire(missing)).toBe('');
  });

  it('should expose the 512 KiB preview ceiling', () => {
    expect(MAX_PREVIEW_BYTES).toBe(512 * 1024);
  });
});

describe('listFiles (local)', () => {
  it('should list entries with directories first and ignored names filtered out', async () => {
    const cwd = tempRoot();
    mkdirSync(join(cwd, 'zeta'));
    mkdirSync(join(cwd, 'node_modules'));
    mkdirSync(join(cwd, '.git'));
    writeFileSync(join(cwd, 'b.txt'), 'b');
    writeFileSync(join(cwd, 'a.txt'), 'a');
    const { svc, files } = makeService(cwd);

    await svc.listFiles();
    svc.unwatchDir();

    const [msg] = files();
    expect(msg.path).toBe('');
    expect(msg.parent).toBe(absoluteParent(wireOf(cwd)));
    expect(msg.entries.map((e) => e.name)).toEqual(['zeta', 'a.txt', 'b.txt']);
    expect(msg.entries[0].type).toBe('dir');
    expect(msg.entries[1].kind).toBe('text');
    expect(msg.truncated).toBe(false);
  });

  it('should list a nested directory and report its parent wire', async () => {
    const cwd = tempRoot();
    mkdirSync(join(cwd, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(cwd, 'sub', 'deep', 'x.md'), '# x');
    const { svc, files } = makeService(cwd);

    await svc.listFiles('sub/deep');
    svc.unwatchDir();

    const [msg] = files();
    expect(msg.path).toBe('sub/deep');
    expect(msg.parent).toBe('sub');
    expect(msg.entries.map((e) => e.name)).toEqual(['x.md']);
  });

  it('should warn when the requested path escapes the workspace', async () => {
    const cwd = tempRoot();
    const { svc, notices, files } = makeService(cwd);

    await svc.listFiles('../escape');

    expect(files()).toHaveLength(0);
    expect(notices('warning')[0].text).toContain('路径超出工作区');
  });

  it('should warn when a relative directory does not exist', async () => {
    const cwd = tempRoot();
    const { svc, notices } = makeService(cwd);

    await svc.listFiles('missing');

    expect(notices('warning')[0].text).toContain('目录不存在');
  });

  it('should warn when the target is a file, not a directory', async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, 'file.txt'), 'x');
    const { svc, notices } = makeService(cwd);

    await svc.listFiles('file.txt');

    expect(notices('warning')[0].text).toContain('不是目录');
  });

  it('should list an absolute wire directory with absolute flag', async () => {
    const cwd = tempRoot();
    const other = tempRoot();
    writeFileSync(join(other, 'o.txt'), 'o');
    const { svc, files, notices } = makeService(cwd);

    await svc.listFiles(wireOf(other));
    svc.unwatchDir();

    const [msg] = files();
    expect(msg.absolute).toBe(true);
    expect(msg.path).toBe(wireOf(other));
    expect(msg.entries.map((e) => e.name)).toEqual(['o.txt']);
    expect(notices()).toHaveLength(0);
  });

  it('should report an unreadable absolute wire directory', async () => {
    const cwd = tempRoot();
    const { svc, files, notices } = makeService(cwd);

    await svc.listFiles(`${Date.now()}-missing-wire`);

    expect(files()).toHaveLength(1);
    expect(files()[0].entries).toEqual([]);
    expect(notices('warning')[0].text).toContain('目录不存在');
  });

  it('should expand ~ and list the home directory', async () => {
    const cwd = tempRoot();
    const { svc, files } = makeService(cwd);

    await svc.listFiles('~');
    svc.unwatchDir();

    expect(files()[0].path).toBe(wireOf(homedir()));
    expect(files()[0].absolute).toBe(true);
  });

  it('should list the machine root instead of the workspace', async () => {
    const cwd = tempRoot();
    const { svc, files } = makeService(cwd);

    await svc.listFiles(MACHINE_ROOT);

    const [msg] = files();
    expect(msg.path).toBe(MACHINE_ROOT);
    expect(msg.parent).toBeNull();
    expect(msg.absolute).toBe(true);
    if (isWin) expect(msg.entries.length).toBeGreaterThan(0);
    if (isWin) expect(msg.entries.every((e) => /^[A-Z]:$/.test(e.name))).toBe(true);
  });
});

describe('readFile (local)', () => {
  it('should emit decoded text with line count and size', async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, 'a.txt'), 'alpha\nbeta\n');
    const { svc, seen } = makeService(cwd);

    await svc.readFile('a.txt');

    const msg = seen.find((m) => m.type === 'file_content');
    expect(msg).toMatchObject({
      type: 'file_content',
      path: 'a.txt',
      name: 'a.txt',
      text: 'alpha\nbeta\n',
      binary: false,
      kind: 'text',
      truncated: false,
      size: 11,
    });
    expect(msg).toHaveProperty('lines', 2);
  });

  it('should emit a hex dump for binary content', async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, 'a.bin'), Buffer.from([0x00, 0x41, 0x42]));
    const { svc, seen } = makeService(cwd);

    await svc.readFile('a.bin');

    const msg = seen.find((m) => m.type === 'file_content');
    if (msg?.type !== 'file_content') throw new Error('missing file_content message');
    expect(msg.binary).toBe(true);
    expect(msg.kind).toBe('none');
    expect(msg.text).toContain('00 41 42');
  });

  it('should skip payload reads for media previews', async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { svc, seen } = makeService(cwd);

    await svc.readFile('pic.png');

    const msg = seen.find((m) => m.type === 'file_content');
    expect(msg).toMatchObject({ binary: true, kind: 'image', text: '', lines: 0, size: 4 });
  });

  it('should read absolute wire files and normalise their path', async () => {
    const cwd = tempRoot();
    const other = tempRoot();
    const file = join(other, 'abs.txt');
    writeFileSync(file, 'abs');
    const { svc, seen } = makeService(cwd);

    await svc.readFile(wireOf(file));

    const msg = seen.find((m) => m.type === 'file_content');
    expect(msg).toMatchObject({ path: wireOf(file), text: 'abs' });
  });

  it('should warn for directories, escapes and missing files', async () => {
    const cwd = tempRoot();
    mkdirSync(join(cwd, 'dir'));
    const { svc, notices } = makeService(cwd);

    await svc.readFile('dir');
    expect(notices('warning').at(-1)!.text).toContain('不是文件');

    await svc.readFile('../outside.txt');
    expect(notices('warning').at(-1)!.text).toContain('路径超出工作区');

    await svc.readFile('missing.txt');
    expect(notices('error').at(-1)!.text).toContain('读取文件失败');
  });
});

describe('writeFile (local)', () => {
  it('should save text, notify and re-read the file', async () => {
    const cwd = tempRoot();
    const file = join(cwd, 'a.txt');
    writeFileSync(file, 'old');
    const { svc, seen, notices } = makeService(cwd);

    await svc.writeFile('a.txt', 'replacement');

    expect(readFileSync(file, 'utf8')).toBe('replacement');
    expect(notices('info')[0].text).toContain('已保存');
    const content = seen.filter((m) => m.type === 'file_content').at(-1);
    expect(content).toMatchObject({ text: 'replacement' });
  });

  it('should reject content above the 2 MiB save ceiling', async () => {
    const cwd = tempRoot();
    const file = join(cwd, 'a.txt');
    writeFileSync(file, 'old');
    const { svc, notices } = makeService(cwd);

    await svc.writeFile('a.txt', 'x'.repeat(2 * 1024 * 1024 + 1));

    expect(notices('warning')[0].text).toContain('文件内容过大');
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it('should refuse to save outside the workspace or onto a directory', async () => {
    const cwd = tempRoot();
    mkdirSync(join(cwd, 'dir'));
    const { svc, notices } = makeService(cwd);

    await svc.writeFile('../escape.txt', 'x');
    expect(notices('warning').at(-1)!.text).toContain('路径超出工作区');

    await svc.writeFile('dir', 'x');
    expect(notices('warning').at(-1)!.text).toContain('不是文件');
  });
});

describe('uploadFile (local)', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('should write a new file, notify and correlate the upload id', async () => {
    const cwd = tempRoot();
    const { svc, seen, notices } = makeService(cwd);

    await svc.uploadFile('sub', 'b.txt', b64('hello'), 'up-1');

    expect(readFileSync(join(cwd, 'sub', 'b.txt'), 'utf8')).toBe('hello');
    expect(notices('error')).toHaveLength(0);
    expect(notices('info')[0].text).toContain('已上传：sub/b.txt');
    expect(seen.filter((m) => m.type === 'file_upload_result')).toEqual([
      { type: 'file_upload_result', uploadId: 'up-1', ok: true },
    ]);
    expect(seen.filter((m) => m.type === 'file_changed')).toEqual([
      { type: 'file_changed', path: 'sub' },
    ]);
  });

  it('should keep the upload result silent when no upload id is supplied', async () => {
    const cwd = tempRoot();
    const { svc, seen } = makeService(cwd);

    await svc.uploadFile('', 'plain.txt', b64('x'));

    expect(readFileSync(join(cwd, 'plain.txt'), 'utf8')).toBe('x');
    expect(seen.filter((m) => m.type === 'file_upload_result')).toEqual([]);
  });

  it('should refuse to overwrite an existing file', async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, 'a.txt'), 'keep');
    const { svc, notices } = makeService(cwd);

    await svc.uploadFile('', 'a.txt', b64('replace'), 'up-2');

    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('keep');
    expect(notices('error')[0].text).toContain('已存在');
  });

  it('should reject unsafe, dotted and empty names', async () => {
    const cwd = tempRoot();
    const { svc, notices } = makeService(cwd);

    for (const name of ['..', 'a..', '', '.']) await svc.uploadFile('', name, b64('x'));

    expect(notices('error')).toHaveLength(4);
    expect(existsSync(join(cwd, 'a..'))).toBe(false);
  });

  it('should reject win32 reserved device names', async () => {
    if (!isWin) return;
    const cwd = tempRoot();
    const { svc, notices } = makeService(cwd);

    await svc.uploadFile('', 'con.txt', b64('x'));

    expect(notices('error')).toHaveLength(1);
    expect(existsSync(join(cwd, 'con.txt'))).toBe(false);
  });

  it('should reject empty payloads and payloads above the configured cap', async () => {
    const cwd = tempRoot();
    const { svc, notices } = makeService(cwd, { getUploadMaxBytes: () => 4 });

    await svc.uploadFile('', 'empty.txt', '');
    expect(notices('error').at(-1)!.text).toContain('空文件');

    await svc.uploadFile('', 'big.txt', b64('123456789'));
    expect(notices('error').at(-1)!.text).toContain('文件过大');
    expect(existsSync(join(cwd, 'big.txt'))).toBe(false);

    await svc.uploadFile('', 'at-limit.txt', b64('1234'));
    expect(readFileSync(join(cwd, 'at-limit.txt'), 'utf8')).toBe('1234');
  });

  it('should reject directories that escape the workspace', async () => {
    const cwd = tempRoot();
    const { svc, notices } = makeService(cwd);

    await svc.uploadFile('../evil', 'x.txt', b64('x'), 'up-3');

    expect(notices('error')[0].text).toContain('路径超出工作区');
    expect(existsSync(join(cwd, '..', 'evil', 'x.txt'))).toBe(false);
  });

  it('should allow uploading into an absolute wire directory', async () => {
    const cwd = tempRoot();
    const other = tempRoot();
    mkdirSync(join(other, 'nested'));
    const { svc, notices } = makeService(cwd);

    await svc.uploadFile(wireOf(join(other, 'nested')), 'abs.txt', b64('abs'));

    expect(readFileSync(join(other, 'nested', 'abs.txt'), 'utf8')).toBe('abs');
    expect(notices('info')[0].text).toContain('已上传');
  });
});

describe('createEntry / renameEntry / deleteEntry / copyEntry', () => {
  it('should create files and folders and notify the parent', async () => {
    const cwd = tempRoot();
    const { svc, seen, notices } = makeService(cwd);

    await svc.createEntry('', 'new.txt', 'file');
    await svc.createEntry('', 'folder', 'dir');

    expect(readFileSync(join(cwd, 'new.txt'), 'utf8')).toBe('');
    expect(existsSync(join(cwd, 'folder'))).toBe(true);
    expect(notices('info').map((m) => m.text)).toEqual([
      '已新建文件：new.txt',
      '已新建文件夹：folder',
    ]);
    expect(seen.filter((m) => m.type === 'file_changed')).toHaveLength(2);
  });

  it('should reject duplicate, invalid and out-of-workspace create targets', async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, 'dup.txt'), 'x');
    const { svc, notices } = makeService(cwd);

    await svc.createEntry('', 'dup.txt', 'file');
    expect(notices('error').at(-1)!.text).toContain('已存在');

    await svc.createEntry('', '..', 'file');
    expect(notices('error').at(-1)!.text).toContain('文件名不合法');

    await svc.createEntry('../nowhere', 'a.txt', 'file');
    expect(notices('error').at(-1)!.text).toContain('目录不存在或超出工作区');
  });

  it('should rename entries and reject collisions', async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, 'a.txt'), 'a');
    writeFileSync(join(cwd, 'b.txt'), 'b');
    const { svc, notices } = makeService(cwd);

    await svc.renameEntry('a.txt', 'c.txt');
    expect(readFileSync(join(cwd, 'c.txt'), 'utf8')).toBe('a');
    expect(existsSync(join(cwd, 'a.txt'))).toBe(false);

    await svc.renameEntry('c.txt', 'b.txt');
    expect(notices('error').at(-1)!.text).toContain('已存在');

    await svc.renameEntry('c.txt', '..');
    expect(notices('error').at(-1)!.text).toContain('新名称不合法');

    await svc.renameEntry(MACHINE_ROOT, 'x');
    expect(notices('error').at(-1)!.text).toContain('此处不可重命名');
  });

  it('should delete entries recursively and reject the machine root', async () => {
    const cwd = tempRoot();
    mkdirSync(join(cwd, 'dir', 'inner'), { recursive: true });
    writeFileSync(join(cwd, 'dir', 'inner', 'x.txt'), 'x');
    const { svc, notices, seen } = makeService(cwd);

    await svc.deleteEntry('dir');
    expect(existsSync(join(cwd, 'dir'))).toBe(false);
    expect(notices('info')[0].text).toContain('已删除');

    await svc.deleteEntry(MACHINE_ROOT);
    expect(notices('error').at(-1)!.text).toContain('此处不可删除');
    expect(seen.filter((m) => m.type === 'file_changed')).toHaveLength(1);
  });

  it('should copy with dedupe names and support moving', async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, 'a.txt'), 'one');
    mkdirSync(join(cwd, 'dest'));
    const { svc } = makeService(cwd);

    await svc.copyEntry('a.txt', '');
    expect(readFileSync(join(cwd, 'a copy.txt'), 'utf8')).toBe('one');

    await svc.copyEntry('a.txt', 'dest', true);
    expect(readFileSync(join(cwd, 'dest', 'a.txt'), 'utf8')).toBe('one');
    expect(existsSync(join(cwd, 'a.txt'))).toBe(false);
  });

  it('should reject copying into itself, onto existing move targets and missing destinations', async () => {
    const cwd = tempRoot();
    mkdirSync(join(cwd, 'dir', 'inner'), { recursive: true });
    writeFileSync(join(cwd, 'a.txt'), 'a');
    mkdirSync(join(cwd, 'dest'));
    writeFileSync(join(cwd, 'dest', 'a.txt'), 'existing');
    const { svc, notices } = makeService(cwd);

    await svc.copyEntry('dir', 'dir/inner');
    expect(notices('error').at(-1)!.text).toContain('不可复制/移动到自身');

    await svc.copyEntry('a.txt', 'dest', true);
    expect(notices('error').at(-1)!.text).toContain('目标已存在');

    await svc.copyEntry('a.txt', 'missing-dir');
    expect(notices('error').at(-1)!.text).toContain('目标目录不存在');

    await svc.copyEntry(MACHINE_ROOT, 'dest');
    expect(notices('error').at(-1)!.text).toContain('此处不可复制');
  });
});

describe('makeDir', () => {
  it('should create a nested directory and return its absolute path', async () => {
    const cwd = tempRoot();
    const { svc, notices } = makeService(cwd);

    const abs = await svc.makeDir('a/b/c');

    expect(abs).toBe(join(cwd, 'a', 'b', 'c'));
    expect(existsSync(abs!)).toBe(true);
    expect(notices('info')[0].text).toContain('已创建文件夹');
  });

  it('should return null and report an empty path', async () => {
    const cwd = tempRoot();
    const { svc, notices } = makeService(cwd);

    const abs = await svc.makeDir('   ');

    expect(abs).toBeNull();
    expect(notices('error')[0].text).toContain('创建文件夹失败');
  });

  it('should expand ~ to the home directory', async () => {
    const cwd = tempRoot();
    const name = `pi-mkdir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const expected = join(homedir(), name);
    const { svc } = makeService(cwd);

    const abs = await svc.makeDir(`~/${name}`);

    expect(abs).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    rmSync(expected, { recursive: true, force: true });
  });
});

describe('searchFiles (local)', () => {
  it('should return an empty result set for a blank query', async () => {
    const cwd = tempRoot();
    const { svc, seen } = makeService(cwd);

    await svc.searchFiles('   ', 1);

    expect(seen).toContainEqual({ type: 'search_files_result', reqId: 1, ok: true, results: [] });
  });

  it('should walk the workspace case-insensitively and match relative paths', async () => {
    const cwd = tempRoot();
    mkdirSync(join(cwd, 'nested', 'deep'), { recursive: true });
    writeFileSync(join(cwd, 'nested', 'deep', 'target.txt'), 'x');
    const { svc, seen } = makeService(cwd);

    await svc.searchFiles('NESTED/DEEP', 2);

    const msg = seen.find((m) => m.type === 'search_files_result' && m.reqId === 2);
    expect(msg).toMatchObject({ ok: true });
    const results = (msg as { results: { path: string; type: string }[] }).results;
    expect(results.map((r) => r.path)).toContain('nested/deep');
    expect(results.map((r) => r.path)).toContain('nested/deep/target.txt');
  });

  it('should resolve an absolute file query directly', async () => {
    const cwd = tempRoot();
    const other = tempRoot();
    const file = join(other, 'abs.txt');
    writeFileSync(file, 'x');
    const { svc, seen } = makeService(cwd);

    await svc.searchFiles(wireOf(file), 3);

    const msg = seen.find((m) => m.type === 'search_files_result' && m.reqId === 3) as {
      results: { name: string; type: string }[];
    };
    expect(msg.results[0]).toMatchObject({ name: 'abs.txt', type: 'file' });
  });

  it('should return no results for an unmatched query', async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, 'a.txt'), 'x');
    const { svc, seen } = makeService(cwd);

    await svc.searchFiles('zzz-nope', 4);

    expect(seen).toContainEqual({ type: 'search_files_result', reqId: 4, ok: true, results: [] });
  });
});

describe('completePath (local)', () => {
  it('should return no completions for blank input', async () => {
    const cwd = tempRoot();
    const { svc, seen } = makeService(cwd);

    await svc.completePath('  ');

    expect(seen).toContainEqual({ type: 'path_completions', completions: [] });
  });

  it('should complete directory names by prefix with dirs first', async () => {
    const cwd = tempRoot();
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src.txt'), 'x');
    writeFileSync(join(cwd, 'other.md'), 'x');
    const { svc, seen } = makeService(cwd);

    await svc.completePath('sr');

    const msg = seen.find((m) => m.type === 'path_completions') as {
      completions: { name: string; type: string; path: string }[];
    };
    expect(msg.completions.map((c) => c.name)).toEqual(['src', 'src.txt']);
    expect(msg.completions[0].type).toBe('dir');
    expect(wireOf(join(cwd, 'src'))).toBe(msg.completions[0].path);
  });

  it('should complete inside an existing subdirectory', async () => {
    const cwd = tempRoot();
    mkdirSync(join(cwd, 'sub'));
    writeFileSync(join(cwd, 'sub', 'inner.txt'), 'x');
    const { svc, seen } = makeService(cwd);

    await svc.completePath('sub/i');

    const msg = seen.find((m) => m.type === 'path_completions') as {
      completions: { name: string }[];
    };
    expect(msg.completions.map((c) => c.name)).toEqual(['inner.txt']);
  });

  it('should return no completions for a missing directory', async () => {
    const cwd = tempRoot();
    const { svc, seen } = makeService(cwd);

    await svc.completePath('nope/x');

    expect(seen).toContainEqual({ type: 'path_completions', completions: [] });
  });

  it('should complete the machine root and bare drive prefixes', async () => {
    const cwd = tempRoot();
    const { svc, seen } = makeService(cwd);

    await svc.completePath(MACHINE_ROOT);
    const rootMsg = seen.find((m) => m.type === 'path_completions') as { completions: unknown[] };
    if (isWin) expect(rootMsg.completions.length).toBeGreaterThan(0);

    if (isWin) {
      seen.length = 0;
      await svc.completePath(`${cwd[0]}:`);
      const driveMsg = seen.find((m) => m.type === 'path_completions') as {
        completions: { type: string; path: string }[];
      };
      expect(driveMsg.completions.length).toBeGreaterThan(0);
      expect(driveMsg.completions.every((c) => c.path.startsWith(`${cwd[0]}:/`))).toBe(true);
    }
  });
});

describe('revealEntry / openDefaultEntry', () => {
  function stubSpawn(svc: FilesService) {
    const calls: { cmd: string; args: string[]; okText: string }[] = [];
    (svc as unknown as { spawnDetached: unknown }).spawnDetached = vi.fn(
      (cmd: string, args: string[], okText: string) => {
        calls.push({ cmd, args, okText });
        return Promise.resolve();
      },
    );
    return calls;
  }

  it('should reveal the workspace root for an empty path', async () => {
    const cwd = tempRoot();
    const { svc } = makeService(cwd);
    const calls = stubSpawn(svc);

    await svc.revealEntry('');

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain(join(cwd));
    expect(calls[0].okText).toContain(cwd.split(/[\\/]/).pop()!);
  });

  it('should reveal a nested folder and warn for machine root or missing paths', async () => {
    const cwd = tempRoot();
    mkdirSync(join(cwd, 'subfolder'));
    const { svc, notices } = makeService(cwd);
    const calls = stubSpawn(svc);

    await svc.revealEntry('subfolder');
    expect(calls[0].args).toContain(join(cwd, 'subfolder'));

    await svc.revealEntry(MACHINE_ROOT);
    expect(notices('warning').at(-1)!.text).toContain('此处不可定位');

    await svc.revealEntry('missing.txt');
    expect(notices('warning').at(-1)!.text).toContain('文件不存在');
  });

  it('should open a file with the platform default app and reject folders', async () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, 'a.txt'), 'x');
    mkdirSync(join(cwd, 'dir'));
    const { svc, notices } = makeService(cwd);
    const calls = stubSpawn(svc);

    await svc.openDefaultEntry('a.txt');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([join(cwd, 'a.txt')]);
    expect(calls[0].okText).toContain('a.txt');

    await svc.openDefaultEntry('dir');
    expect(notices('warning').at(-1)!.text).toContain('请选择文件');

    await svc.openDefaultEntry('missing.txt');
    expect(notices('warning').at(-1)!.text).toContain('文件不存在');
  });
});

describe('scmQuery', () => {
  it('should report notRepo for a directory outside any git repository', async () => {
    const cwd = tempRoot();
    const { svc, seen } = makeService(cwd);

    await svc.scmQuery('status', 7);
    svc.unwatchGit();

    const msg = seen.find((m) => m.type === 'scm_data');
    expect(msg).toMatchObject({
      type: 'scm_data',
      reqId: 7,
      kind: 'status',
      ok: true,
      notRepo: true,
    });
  });

  it('should reject invalid argument combinations', async () => {
    const cwd = tempRoot();
    const { svc, seen } = makeService(cwd);

    await svc.scmQuery('filediff', 8, {});
    expect(seen.find((m) => m.type === 'scm_data')).toMatchObject({
      ok: false,
      error: 'Invalid scm query arguments',
    });
    svc.unwatchGit();

    seen.length = 0;
    await svc.scmQuery('commit', 9, { hash: 'not-a-hash' });
    expect(seen.find((m) => m.type === 'scm_data')).toMatchObject({ ok: false });
  });

  it('should reject file diffs outside the workspace', async () => {
    const cwd = tempRoot();
    const { svc, seen } = makeService(cwd);

    await svc.scmQuery('filediff', 10, { path: '../outside.txt' });

    expect(seen.find((m) => m.type === 'scm_data')).toMatchObject({
      ok: false,
      error: 'Path is outside the workspace',
    });
    svc.unwatchGit();
  });
});

describe('remote workspace branches', () => {
  it('should list remote entries, filtering ignored names and marking absolute listings', async () => {
    const ssh = fakeSsh({
      sftpReaddir: vi.fn(() =>
        Promise.resolve([
          { name: 'node_modules', type: 'dir' },
          { name: 'src', type: 'dir' },
          { name: 'main.ts', type: 'file' },
        ]),
      ),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, seen, files } = makeService(REMOTE);

    await svc.listFiles('');
    const [msg] = files();
    expect(msg.path).toBe('');
    expect(msg.entries.map((e) => e.name)).toEqual(['src', 'main.ts']);
    expect(msg.entries[1].kind).toBe('text');

    seen.length = 0;
    await svc.listFiles('src/deep');
    expect(files()[0].path).toBe('src/deep');
    expect(files()[0].parent).toBe('src');

    seen.length = 0;
    await svc.listFiles('/etc');
    expect(files()[0].absolute).toBe(true);
    expect(files()[0].parent).toBe('/');
  });

  it('should list the remote machine root and reject remote escapes', async () => {
    const ssh = fakeSsh();
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, seen, files, notices } = makeService(REMOTE);

    await svc.listFiles(MACHINE_ROOT);
    expect(files()[0].entries).toEqual([{ name: '/', path: '/', type: 'dir' }]);

    seen.length = 0;
    await svc.listFiles('../escape');
    expect(files()).toHaveLength(0);
    expect(notices('warning').at(-1)!.text).toContain('路径超出工作区');
  });

  it('should emit empty entries plus a notice when remote listing fails', async () => {
    const ssh = fakeSsh({
      sftpReaddir: vi.fn(() => {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        return Promise.reject(err);
      }),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, files, notices } = makeService(REMOTE);

    await svc.listFiles('sub');

    expect(files()[0].entries).toEqual([]);
    expect(notices().at(-1)!.text).toContain('目录不可读');
    expect(notices().at(-1)!.textEn).toContain('Directory is not readable');
  });

  it('should read remote text, binary and media files', async () => {
    const ssh = fakeSsh({
      sftpStat: vi.fn(() =>
        Promise.resolve({ isFile: true, isDirectory: false, size: 5, mtime: 0 }),
      ),
      sftpReadFile: vi.fn(() => Promise.resolve({ data: Buffer.from('hello'), size: 5 })),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, seen } = makeService(REMOTE);

    await svc.readFile('a.txt');
    expect(seen.find((m) => m.type === 'file_content')).toMatchObject({
      path: 'a.txt',
      text: 'hello',
      binary: false,
      size: 5,
    });

    seen.length = 0;
    ssh.sftpStat.mockResolvedValue({ isFile: true, isDirectory: false, size: 4, mtime: 0 });
    await svc.readFile('pic.png');
    expect(seen.find((m) => m.type === 'file_content')).toMatchObject({
      kind: 'image',
      binary: true,
    });
    expect(ssh.sftpReadFile).toHaveBeenCalledTimes(1);

    seen.length = 0;
    ssh.sftpReadFile.mockResolvedValue({ data: Buffer.from([0x00, 0x41]), size: 2 });
    await svc.readFile('blob.dat');
    expect(seen.find((m) => m.type === 'file_content')).toMatchObject({
      binary: true,
      kind: 'none',
    });
  });

  it('should report remote read failures and non-files', async () => {
    const ssh = fakeSsh({
      sftpStat: vi.fn(() =>
        Promise.resolve({ isFile: false, isDirectory: true, size: 0, mtime: 0 }),
      ),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, notices } = makeService(REMOTE);

    await svc.readFile('dir');
    expect(notices('warning').at(-1)!.text).toContain('不是文件');

    ssh.sftpStat.mockRejectedValueOnce(new Error('stat broke'));
    await svc.readFile('a.txt');
    expect(notices('error').at(-1)!.text).toContain('读取远程文件失败');
  });

  it('should write remote files and re-read them', async () => {
    const ssh = fakeSsh({
      sftpStat: vi.fn(() =>
        Promise.resolve({ isFile: true, isDirectory: false, size: 10, mtime: 0 }),
      ),
      sftpReadFile: vi.fn(() => Promise.resolve({ data: Buffer.from('next'), size: 10 })),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, notices, seen } = makeService(REMOTE);

    await svc.writeFile('a.txt', 'next');

    expect(ssh.sftpWriteFile).toHaveBeenCalledWith(REMOTE, '/work/a.txt', 'next');
    expect(notices('info')[0].text).toContain('已保存：a.txt');
    expect(seen.find((m) => m.type === 'file_content')).toMatchObject({ text: 'next' });
  });

  it('should reject oversized remote writes and non-file targets', async () => {
    const ssh = fakeSsh({
      sftpStat: vi.fn(() =>
        Promise.resolve({ isFile: false, isDirectory: true, size: 0, mtime: 0 }),
      ),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, notices } = makeService(REMOTE);

    await svc.writeFile('a.txt', 'x'.repeat(2 * 1024 * 1024 + 1));
    expect(notices('warning').at(-1)!.text).toContain('文件内容过大');
    expect(ssh.sftpWriteFile).not.toHaveBeenCalled();

    await svc.writeFile('dir', 'x');
    expect(notices('error').at(-1)!.text).toContain('Remote save target must be a regular file');
  });

  it('should upload remote files exclusively and correlate the result', async () => {
    const ssh = fakeSsh({ sftpStat: vi.fn(() => Promise.resolve(null)) });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, seen, notices } = makeService(REMOTE);

    await svc.uploadFile('sub', 'a.txt', Buffer.from('body').toString('base64'), 'up-r');

    expect(ssh.sftpWriteFile).toHaveBeenCalled();
    expect(ssh.execInWorkspace).toHaveBeenCalled();
    expect(notices('info')[0].text).toContain('已上传：sub/a.txt');
    expect(seen.filter((m) => m.type === 'file_upload_result')).toEqual([
      { type: 'file_upload_result', uploadId: 'up-r', ok: true },
    ]);
  });

  it('should reject remote uploads for existing targets, bad names and missing services', async () => {
    const ssh = fakeSsh({ sftpStat: vi.fn(() => Promise.resolve({ isFile: true, size: 1 })) });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, notices } = makeService(REMOTE);
    const payload = Buffer.from('body').toString('base64');

    await svc.uploadFile('', 'a.txt', payload);
    expect(notices('error').at(-1)!.text).toContain('已存在');

    await svc.uploadFile('', '..', payload);
    expect(notices('error').at(-1)!.text).toContain('文件名不合法');

    await svc.uploadFile('', 'empty.txt', '');
    expect(notices('error').at(-1)!.text).toContain('文件大小不合法');

    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(null);
    await svc.uploadFile('', 'x.txt', payload, 'up-fail');
    expect(notices('error').at(-1)!.text).toContain('上传文件失败');
  });

  it('should create, rename and delete remote entries', async () => {
    const ssh = fakeSsh({ sftpStat: vi.fn(() => Promise.resolve(null)) });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, seen, notices } = makeService(REMOTE);

    await svc.createEntry('sub', 'new.txt', 'file');
    expect(ssh.sftpWriteFile).toHaveBeenCalledWith(REMOTE, '/work/sub/new.txt', '');

    await svc.createEntry('', 'folder', 'dir');
    expect(ssh.sftpMkdirRecursive).toHaveBeenCalledWith(REMOTE, '/work/folder');

    await svc.renameEntry('sub/new.txt', 'renamed.txt');
    expect(ssh.sftpRename).toHaveBeenCalledWith(
      REMOTE,
      '/work/sub/new.txt',
      '/work/sub/renamed.txt',
    );

    await svc.deleteEntry('folder');
    expect(ssh.sftpRemove).toHaveBeenCalledWith(REMOTE, '/work/folder');
    expect(notices('info').map((m) => m.text)).toEqual([
      '已新建文件：new.txt',
      '已新建文件夹：folder',
      '已重命名为：renamed.txt',
      '已删除：folder',
    ]);
    expect(seen.filter((m) => m.type === 'file_changed')).toHaveLength(4);
  });

  it('should reject remote create/rename collisions and invalid names', async () => {
    const ssh = fakeSsh({ sftpStat: vi.fn(() => Promise.resolve({ isFile: true, size: 1 })) });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, notices } = makeService(REMOTE);

    await svc.createEntry('', 'dup.txt', 'file');
    expect(notices('error').at(-1)!.text).toContain('已存在同名项');

    await svc.createEntry('', '..', 'file');
    expect(notices('error').at(-1)!.text).toContain('名称不合法');

    await svc.renameEntry('a.txt', 'b.txt');
    expect(notices('error').at(-1)!.text).toContain('目标已存在');

    await svc.renameEntry('a.txt', '..');
    expect(notices('error').at(-1)!.text).toContain('新名称不合法');
  });

  it('should copy and move remote entries with self-copy dedupe', async () => {
    const ssh = fakeSsh();
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, seen, notices } = makeService(REMOTE);

    await svc.copyEntry('sub/a.txt', 'dest');
    expect(ssh.sftpCopy).toHaveBeenCalledWith(
      REMOTE,
      '/work/sub/a.txt',
      '/work/dest/a.txt',
      undefined,
    );

    await svc.copyEntry('sub/a.txt', 'sub', true);
    expect(ssh.sftpCopy).toHaveBeenCalledTimes(1);

    await svc.copyEntry('sub/a.txt', 'sub');
    expect(ssh.sftpCopy).toHaveBeenLastCalledWith(
      REMOTE,
      '/work/sub/a.txt',
      '/work/sub/a copy.txt',
      undefined,
    );

    expect(notices('info')[0].text).toContain('已复制：a.txt');
    expect(seen.filter((m) => m.type === 'file_changed').length).toBeGreaterThan(0);
  });

  it('should complete remote paths by prefix', async () => {
    const ssh = fakeSsh({
      sftpReaddir: vi.fn(() =>
        Promise.resolve([
          { name: 'inner.txt', type: 'file' },
          { name: 'innerdir', type: 'dir' },
          { name: 'other.txt', type: 'file' },
        ]),
      ),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, seen } = makeService(REMOTE);

    await svc.completePath('sub/inner');

    const msg = seen.find((m) => m.type === 'path_completions') as {
      completions: { name: string; type: string; path: string }[];
    };
    expect(msg.completions.map((c) => c.name)).toEqual(['innerdir', 'inner.txt']);
    expect(msg.completions[0].path).toBe('/work/sub/innerdir');
  });

  it('should fall back to an empty completion list when the remote service is missing', async () => {
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(null);
    const { svc, seen } = makeService(REMOTE);

    await svc.completePath('sub');

    expect(seen).toContainEqual({ type: 'path_completions', completions: [] });
  });

  it('should search remote files through find and cap the result set', async () => {
    const ssh = fakeSsh({
      sftpStat: vi.fn(() => Promise.reject(new Error('no such file'))),
      execInWorkspace: vi.fn(() =>
        Promise.resolve({
          exitCode: 0,
          stdout: ['a.txt', './b.txt', 'dir/c.txt'].join('\n'),
          stderr: '',
        }),
      ),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, seen } = makeService(REMOTE);

    await svc.searchFiles('txt', 11);

    const msg = seen.find((m) => m.type === 'search_files_result' && m.reqId === 11) as {
      ok: boolean;
      results: { path: string; name: string; type: string }[];
    };
    expect(msg.ok).toBe(true);
    expect(msg.results.map((r) => r.path)).toEqual(['a.txt', 'b.txt', 'dir/c.txt']);
    expect(msg.results.every((r) => r.type === 'file')).toBe(true);
  });

  it('should report remote search failures and blank queries', async () => {
    const ssh = fakeSsh({
      execInWorkspace: vi.fn(() => Promise.reject(new Error('ssh dropped'))),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, seen } = makeService(REMOTE);

    await svc.searchFiles('x', 12);
    expect(seen).toContainEqual({ type: 'search_files_result', reqId: 12, ok: false, results: [] });

    seen.length = 0;
    await svc.searchFiles('   ', 13);
    expect(seen).toContainEqual({ type: 'search_files_result', reqId: 13, ok: true, results: [] });

    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(null);
    seen.length = 0;
    await svc.searchFiles('x', 14);
    expect(seen).toContainEqual({ type: 'search_files_result', reqId: 14, ok: false, results: [] });
  });

  it('should create remote folders through sftpMkdirRecursive', async () => {
    const ssh = fakeSsh();
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, notices } = makeService(REMOTE);

    const result = await svc.makeDir('new/nested');

    expect(ssh.sftpMkdirRecursive).toHaveBeenCalledWith(REMOTE, '/work/new/nested');
    expect(result).toBe('/work/new/nested');
    expect(notices('info')[0].text).toContain('已创建远程文件夹');
  });

  it('should report remote folder creation failures', async () => {
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(null);
    const { svc, notices } = makeService(REMOTE);

    const result = await svc.makeDir('new');

    expect(result).toBeNull();
    expect(notices('error')[0].text).toContain('创建远程文件夹失败');
  });

  it('should surface non-repo git failures as notRepo for remote history', async () => {
    const ssh = fakeSsh({
      execInWorkspace: vi.fn(() =>
        Promise.resolve({
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: not a git repository',
        }),
      ),
    });
    vi.spyOn(remoteSsh, 'getGlobalRemoteSshService').mockReturnValue(ssh as never);
    const { svc, seen } = makeService(REMOTE);

    await svc.scmQuery('history', 15);

    expect(seen.find((m) => m.type === 'scm_data')).toMatchObject({
      reqId: 15,
      kind: 'history',
      ok: true,
      notRepo: true,
    });
  });
});
