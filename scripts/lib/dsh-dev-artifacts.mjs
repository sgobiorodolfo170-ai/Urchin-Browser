import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 按上游 workspace 声明检查运行时出口，不遍历 node_modules 链接树。 */
export function missingRuntimeArtifacts(root, exportName = './typert') {
  const workspace = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifests = new Set();
  for (const pattern of workspace.workspaces ?? []) {
    if (pattern.includes('**') || pattern.startsWith('!'))
      throw new Error(`不支持的 workspace 模式：${pattern}`);
    let dirs = [root];
    for (const part of pattern.split('/')) {
      dirs = dirs.flatMap((dir) => {
        if (!existsSync(dir)) return [];
        if (part !== '*') return [join(dir, part)];
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(dir, entry.name));
      });
    }
    for (const dir of dirs) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) manifests.add(manifest);
    }
  }
  const missing = [];
  let contributors = 0;
  for (const manifest of manifests) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    const target = pkg.exports?.[exportName];
    if (target === undefined) continue;
    const file = typeof target === 'string' ? target : target.default;
    if (typeof file !== 'string') throw new Error(`无法识别 ${pkg.name} 的 ${exportName} 出口`);
    contributors++;
    const artifact = join(manifest, '..', file);
    if (!existsSync(artifact)) missing.push(artifact);
  }
  if (contributors === 0) throw new Error(`未发现 ${exportName} contributor，拒绝把空检查视为就绪`);
  return { contributors, missing };
}

/** tsx 下不依赖 import.meta.main：显式调用上游导出的生成入口。 */
export const typertGeneratorArgs = [
  '--import',
  'tsx/esm',
  '--input-type=module',
  '--eval',
  "import { main } from './scripts/generate-typert.ts'; process.exitCode = main([], process.cwd());",
];
