import { test, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
interface ArtifactTools {
  missingRuntimeArtifacts(
    root: string,
    exportName?: string,
  ): { contributors: number; missing: string[] };
  typertGeneratorArgs: string[];
}
let missingRuntimeArtifacts: ArtifactTools['missingRuntimeArtifacts'];
let typertGeneratorArgs: string[];
beforeAll(async () => {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../scripts/lib/dsh-dev-artifacts.mjs',
  );
  const tools = (await import(pathToFileURL(path).href)) as ArtifactTools;
  missingRuntimeArtifacts = tools.missingRuntimeArtifacts;
  typertGeneratorArgs = tools.typertGeneratorArgs;
});

test('检查真实出口文件，不能由版本或依赖安装戳替代；文件丢失后重新检出', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-artifacts-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*/*'] }));
    const pkg = join(root, 'packages', 'llm', 'llm');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(root, '.dsh-installed-version'), '0.2.2-rc.2');
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@deepseek-ai/dsh-llm',
        exports: { './typert': { default: './lib/typert.host.js' } },
      }),
    );
    assert.equal(missingRuntimeArtifacts(root).missing.length, 1);
    mkdirSync(join(pkg, 'lib'));
    const artifact = join(pkg, 'lib', 'typert.host.js');
    writeFileSync(artifact, 'export const TYPERT = {};');
    assert.deepEqual(missingRuntimeArtifacts(root), { contributors: 1, missing: [] });
    rmSync(artifact);
    assert.deepEqual(missingRuntimeArtifacts(root).missing, [artifact]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('没有 contributor 的目录不能误报就绪', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-empty-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    assert.throws(() => missingRuntimeArtifacts(root), /未发现 .*typert/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Client bundle 独立检查，不能由已存在的 Typert 文件代替', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-client-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    const pkg = join(root, 'packages', 'ui');
    mkdirSync(join(pkg, 'lib'), { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: 'ui',
        exports: { './typert': './lib/typert.host.js', './client': './lib/client.js' },
      }),
    );
    writeFileSync(join(pkg, 'lib', 'typert.host.js'), 'export const TYPERT = {};');
    assert.equal(missingRuntimeArtifacts(root).missing.length, 0);
    assert.deepEqual(missingRuntimeArtifacts(root, './client').missing, [
      join(pkg, 'lib', 'client.js'),
    ]);
    writeFileSync(join(pkg, 'lib', 'client.js'), '');
    assert.equal(missingRuntimeArtifacts(root, './client').missing.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('生成命令显式执行 main 并保留非零退出码', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-main-'));
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    // Node v22 不能直接执行 TS；使用相同 eval 和 JS fixture 验证入口调用与错误传播。
    writeFileSync(
      join(root, 'scripts', 'generate-typert.js'),
      'export function main() { return 7; }',
    );
    const code = typertGeneratorArgs.at(-1)!.replace('generate-typert.ts', 'generate-typert.js');
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      cwd: root,
    });
    assert.equal(result.status, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
