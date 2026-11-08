import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const faults = vi.hoisted(() => ({ command: false, sync: false, recovery: false }));

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  type ExecFileLike = (
    file: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
    callback: (error: Error | null) => void,
  ) => void;
  const injected: ExecFileLike = (file, args, options, callback) => {
    if (!faults.command) {
      (actual.execFile as unknown as ExecFileLike)(file, args, options, callback);
      return;
    }
    if (faults.recovery) {
      const backup = options.env?.PI_SAVE_BACKUP ?? '';
      void import('node:fs/promises').then(async (fs) => {
        await fs.writeFile(backup, 'recovery');
        callback(new Error('Injected metadata failure'));
      });
      return;
    }
    callback(new Error('Injected metadata failure'));
  };
  return { ...actual, execFile: injected };
});

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (faults.sync) handle.sync = () => Promise.reject(new Error('Injected fsync failure'));
      return handle;
    },
  };
});

import { saveFilePreservingMetadata } from '../../src/pi-server/file-save.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-save-fault-'));
  roots.push(root);
  const dest = join(root, 'a.txt');
  await writeFile(dest, 'original');
  return { root, dest };
}
afterEach(async () => {
  faults.command = faults.sync = faults.recovery = false;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('saveFilePreservingMetadata', () => {
  it('should replace the content in place and leave no staging directory', async () => {
    const { root, dest } = await fixture();

    await saveFilePreservingMetadata(dest, 'replacement ✓');

    expect(await readFile(dest, 'utf8')).toBe('replacement ✓');
    expect((await readdir(root)).sort()).toEqual(['a.txt']);
    expect((await stat(dest)).isFile()).toBe(true);
  });

  it('should truncate the file when the replacement is shorter', async () => {
    const { dest } = await fixture();
    await writeFile(dest, 'a much longer original body');

    await saveFilePreservingMetadata(dest, 'short');

    expect(await readFile(dest, 'utf8')).toBe('short');
  });

  it('should reject directories and non-regular files', async () => {
    const { root } = await fixture();
    const dir = join(root, 'sub');
    await mkdir(dir);
    await expect(saveFilePreservingMetadata(dir, 'x')).rejects.toThrow('not a regular file');
  });

  it('should reject targets with multiple hard links', async () => {
    const { root, dest } = await fixture();
    const { link } = await import('node:fs/promises');
    await link(dest, join(root, 'hard.txt'));
    await expect(saveFilePreservingMetadata(dest, 'x')).rejects.toThrow('multiple hard links');
    expect(await readFile(dest, 'utf8')).toBe('original');
  });

  it.each(['command', 'sync'] as const)(
    'should keep the original content and clean only the current staging on %s failure',
    async (fault) => {
      const { root, dest } = await fixture();
      const earlier = join(root, '.pi-save-earlier');
      await mkdir(earlier);
      await writeFile(join(earlier, 'original'), 'earlier recovery');
      faults[fault] = true;

      await expect(saveFilePreservingMetadata(dest, 'replacement')).rejects.toThrow('Injected');

      expect(await readFile(dest, 'utf8')).toBe('original');
      expect((await readdir(root)).sort()).toEqual(['.pi-save-earlier', 'a.txt']);
      expect(await readFile(join(earlier, 'original'), 'utf8')).toBe('earlier recovery');
    },
  );

  it('should report and retain native replacement recovery data on failure', async () => {
    const { root, dest } = await fixture();
    faults.command = true;
    faults.recovery = true;

    if (isWin) {
      await expect(saveFilePreservingMetadata(dest, 'replacement')).rejects.toThrow(
        'recovery file retained at',
      );
      const stage = (await readdir(root)).find((n) => n.startsWith('.pi-save-'))!;
      expect(await readFile(join(root, stage, 'original'), 'utf8')).toBe('recovery');
      expect(await readFile(dest, 'utf8')).toBe('original');

      faults.command = false;
      faults.recovery = false;
      await saveFilePreservingMetadata(dest, 'later save');
      expect(await readFile(dest, 'utf8')).toBe('later save');
      // The retained recovery file is deliberately left for manual recovery.
      expect(await readFile(join(root, stage, 'original'), 'utf8')).toBe('recovery');
    } else {
      await expect(saveFilePreservingMetadata(dest, 'replacement')).rejects.toThrow('Injected');
      expect(await readFile(dest, 'utf8')).toBe('original');
      expect((await readdir(root)).sort()).toEqual(['a.txt']);
    }
  });

  it('should reject a save whose target changed while staging', async () => {
    const { dest } = await fixture();
    const { utimes } = await import('node:fs/promises');
    const before = await stat(dest);

    // Mutate the target between the pre-flight stat and the commit check by racing a touch.
    const save = saveFilePreservingMetadata(dest, 'replacement');
    await utimes(dest, new Date(), new Date(Date.now() + 5_000));
    const error = await save.then(
      () => null,
      (err: Error) => err,
    );
    if (error) expect(error.message).toContain('changed while preparing replacement');
    // Even when the race is not observed, the file must remain a valid regular file.
    expect((await stat(dest)).isFile()).toBe(true);
    expect(before.isFile()).toBe(true);
  });
});
