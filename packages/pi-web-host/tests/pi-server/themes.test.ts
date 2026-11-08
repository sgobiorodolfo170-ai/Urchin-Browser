/**
 * themes.ts 单元测试
 *
 * 目录扫描 / 元数据注释解析 / 用户主题覆盖内置 / 路径校验 / @import 内联。
 * 不依赖仓库内置主题资产：全部用临时目录构造。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listThemes,
  readThemeCss,
  resolveBuiltinThemesDir,
  resolveThemeFile,
} from '../../src/pi-server/themes.js';

let root: string;
let builtinDir: string;
let userDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-themes-'));
  builtinDir = join(root, 'builtin');
  userDir = join(root, 'user');
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveBuiltinThemesDir', () => {
  it('should prefer the static root themes dir when it exists', () => {
    const webDist = join(root, 'pi-web');
    mkdirSync(join(webDist, 'themes'), { recursive: true });
    expect(resolveBuiltinThemesDir(join(root, 'pkg'), webDist)).toBe(join(webDist, 'themes'));
  });

  it('should fall back to <pkgRoot>/themes when the static root has no themes dir', () => {
    const webDist = join(root, 'pi-web');
    mkdirSync(webDist, { recursive: true });
    expect(resolveBuiltinThemesDir(join(root, 'pkg'), webDist)).toBe(join(root, 'pkg', 'themes'));
  });
});

describe('listThemes', () => {
  it('should read display names, groups and color schemes from CSS comments', () => {
    writeFileSync(
      join(builtinDir, 'catppuccin.css'),
      '/* theme-name: 卡布奇诺 */\n/* theme-name-en: Catppuccin */\n/* theme-group: classic */\n:root { color-scheme: dark; }\n',
    );
    writeFileSync(
      join(builtinDir, 'paper.css'),
      '/* theme-name: 暖纸 */\n:root { color-scheme: light; }\n',
    );
    const themes = listThemes(builtinDir, userDir);
    expect(themes).toHaveLength(2);
    const cat = themes.find((t) => t.id === 'catppuccin');
    expect(cat).toMatchObject({
      id: 'catppuccin',
      name: '卡布奇诺',
      nameEn: 'Catppuccin',
      group: 'classic',
      scheme: 'dark',
      builtin: true,
    });
    const paper = themes.find((t) => t.id === 'paper');
    expect(paper).toMatchObject({ name: '暖纸', group: 'builtin', scheme: 'light' });
    expect(paper?.nameEn).toBeUndefined();
  });

  it('should fall back to the file id when no name comment exists', () => {
    writeFileSync(join(builtinDir, 'plain.css'), ':root { color-scheme: dark; }');
    expect(listThemes(builtinDir, userDir)[0]).toMatchObject({ id: 'plain', name: 'plain' });
  });

  it('should skip invalid ids and non-css files, and sort by name', () => {
    writeFileSync(join(builtinDir, 'bad..id.css'), 'x');
    writeFileSync(join(builtinDir, 'notes.txt'), 'x');
    writeFileSync(join(builtinDir, 'b.css'), '/* theme-name: Beta */');
    writeFileSync(join(builtinDir, 'a.css'), '/* theme-name: Alpha */');
    const ids = listThemes(builtinDir, userDir).map((t) => t.id);
    expect(ids).toEqual(['a', 'b']);
  });

  it('should keep builtin metadata for a duplicated id but resolve the user file', () => {
    writeFileSync(join(builtinDir, 'shared.css'), '/* theme-name: Builtin */');
    writeFileSync(join(userDir, 'shared.css'), '/* theme-name: User */');
    const themes = listThemes(builtinDir, userDir);
    expect(themes).toHaveLength(1);
    // 当前行为（与上游一致）：列表按 builtin 优先去重，元数据取内置；
    // 但读取时用户文件优先（resolveThemeFile），故 id 仍是同一主题。
    expect(themes[0]).toMatchObject({ id: 'shared', name: 'Builtin', builtin: true });
    expect(resolveThemeFile(builtinDir, userDir, 'shared')).toBe(join(userDir, 'shared.css'));
  });

  it('should tolerate missing directories', () => {
    expect(listThemes(join(root, 'nope'), join(root, 'nope2'))).toEqual([]);
  });

  it('should ignore unreadable color-scheme and group values', () => {
    writeFileSync(
      join(builtinDir, 'odd.css'),
      '/* theme-group: modern */\n:root { color-scheme: sepia; }',
    );
    const [entry] = listThemes(builtinDir, userDir);
    expect(entry?.group).toBe('builtin');
    expect(entry?.scheme).toBeUndefined();
  });
});

describe('resolveThemeFile', () => {
  it('should prefer the user file and fall back to the builtin file', () => {
    writeFileSync(join(builtinDir, 'both.css'), 'builtin');
    writeFileSync(join(userDir, 'both.css'), 'user');
    writeFileSync(join(builtinDir, 'builtin-only.css'), 'builtin');
    expect(resolveThemeFile(builtinDir, userDir, 'both')).toBe(join(userDir, 'both.css'));
    expect(resolveThemeFile(builtinDir, userDir, 'builtin-only')).toBe(
      join(builtinDir, 'builtin-only.css'),
    );
  });

  it('should reject invalid ids and traversal attempts', () => {
    writeFileSync(join(builtinDir, 'ok.css'), 'x');
    expect(resolveThemeFile(builtinDir, userDir, 'ok')).not.toBeNull();
    for (const id of ['..', '../etc/passwd', 'a/b', 'a..b', '']) {
      expect(resolveThemeFile(builtinDir, userDir, id)).toBeNull();
    }
  });

  it('should return null when neither directory has the theme', () => {
    expect(resolveThemeFile(builtinDir, userDir, 'missing')).toBeNull();
  });

  it('should ignore a directory that happens to match the theme name', () => {
    mkdirSync(join(builtinDir, 'dir.css'));
    expect(resolveThemeFile(builtinDir, userDir, 'dir')).toBeNull();
  });
});

describe('readThemeCss', () => {
  it('should wrap a top-level theme in a cascade layer', () => {
    const file = join(builtinDir, 'layer.css');
    writeFileSync(file, ':root { --a: 1; }\n\n');
    expect(readThemeCss(file)).toBe('@layer theme {\n:root { --a: 1; }\n}\n');
  });

  it('should inline relative CSS imports', () => {
    writeFileSync(join(builtinDir, 'base.css'), ':root { --base: 1; }');
    const file = join(builtinDir, 'main.css');
    writeFileSync(file, '@import "./base.css";\n:root { --main: 2; }');
    const css = readThemeCss(file);
    expect(css).toContain('--base: 1');
    expect(css).toContain('--main: 2');
    expect(css).not.toContain('@import');
  });

  it('should drop missing imports and ignore absolute URLs', () => {
    const file = join(builtinDir, 'broken.css');
    writeFileSync(file, '@import "./missing.css";\n@import "https://x/y.css";\n:root {}');
    const css = readThemeCss(file);
    expect(css).toContain(':root {}');
    expect(css).not.toContain('missing.css');
    expect(css).toContain('https://x/y.css');
  });

  it('should survive import cycles', () => {
    const a = join(builtinDir, 'a.css');
    const b = join(builtinDir, 'b.css');
    writeFileSync(a, '@import "./b.css";\n.a{}');
    writeFileSync(b, '@import "./a.css";\n.b{}');
    const css = readThemeCss(a);
    expect(css).toContain('.a{}');
    expect(css).toContain('.b{}');
  });

  it('should return an empty string for a missing file', () => {
    expect(readThemeCss(join(builtinDir, 'ghost.css'))).toBe('');
  });
});
