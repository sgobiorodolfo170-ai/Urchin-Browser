/**
 * 文件关联 · 纯函数单元测试（associations.ts）
 *
 * 验证：
 * 1. getExtensionsForGroup：三组扩展名（白名单过滤：不含 html/代码/脚本类）
 * 2. buildProgId / buildOpenCommand / buildRegAddArgs：ProgID 与命令语法
 * 3. buildAppRegistryEntries / buildExtensionEntries：非侵入注册模型
 *    （Applications\<exe> + Capabilities + OpenWithProgids，**不写 .ext 默认值**）
 * 4. buildAllRegistryEntries：去重 + 应用级条目只写一次
 * 5. buildExtensionRemovals / buildAppRemovals：清理目标只含本应用项
 * 6. parseOpenArgs / parseFileArg / parseUrlArg：命令行解析（跳过 app 目录）
 */
import { describe, it, expect } from 'vitest';
import {
  ASSOCIATION_GROUPS,
  buildAllRegistryEntries,
  buildAppRegistryEntries,
  buildAppRemovals,
  buildDefaultAppsSettingsUri,
  buildDefaultBrowserRegistryEntries,
  buildExtensionEntries,
  buildExtensionRemovals,
  buildOpenCommand,
  buildProgId,
  buildRegistryEntries,
  exeBaseName,
  getExtensionsByGroup,
  getExtensionsForGroup,
  parseFileArg,
  parseOpenArgs,
  parseUrlArg,
} from '../../src/main/file-association/associations';
import {
  buildRegAddArgs,
  buildRegDeleteArgs,
  parseCapabilityExtensions,
} from '../../src/main/file-association/register';

const EXE = 'C:\\apps\\urchin.exe';
const CAPABILITIES_KEY = 'HKCU\\Software\\Clients\\StartMenuInternet\\UrchinBrowser\\Capabilities';

describe('getExtensionsForGroup', () => {
  it('should return audio and video extensions for media group', () => {
    const media = ASSOCIATION_GROUPS.find((g) => g.id === 'media')!;
    const exts = getExtensionsForGroup(media);
    expect(exts).toContain('mp3');
    expect(exts).toContain('mp4');
    expect(exts).toContain('wav');
    expect(exts).not.toContain('pdf');
    // 去重 + 字母序
    expect([...exts].sort()).toEqual([...exts]);
  });

  it('should return pdf/office/markdown/json/text extensions for documents group', () => {
    const docs = ASSOCIATION_GROUPS.find((g) => g.id === 'documents')!;
    const exts = getExtensionsForGroup(docs);
    expect(exts).toContain('pdf');
    expect(exts).toContain('docx');
    expect(exts).toContain('md');
    expect(exts).toContain('json');
    expect(exts).toContain('txt');
    expect(exts).not.toContain('mp3');
  });

  it('should keep html out of the documents group (owned by default-browser capability)', () => {
    // html/mhtml 归 UrchinHTML 能力：同扩展两个 ProgID 会在「打开方式」里出现重复项
    const docs = ASSOCIATION_GROUPS.find((g) => g.id === 'documents')!;
    const exts = getExtensionsForGroup(docs);
    expect(exts).not.toContain('html');
    expect(exts).not.toContain('mhtml');
  });

  it('should never claim code / script / config extensions', () => {
    // 回归：旧模型把 42 个 text 扩展全量登记并改写 .ext 默认值 →
    // 双击 .bat 不再执行、.js 被浏览器抢走。
    const all = Object.values(getExtensionsByGroup()).flat();
    for (const ext of ['js', 'ts', 'bat', 'cmd', 'ps1', 'sh', 'py', 'css', 'sql', 'ini']) {
      expect(all).not.toContain(ext);
    }
  });

  it('should return image extensions for images group', () => {
    const images = ASSOCIATION_GROUPS.find((g) => g.id === 'images')!;
    const exts = getExtensionsForGroup(images);
    expect(exts).toContain('png');
    expect(exts).toContain('jpg');
    expect(exts).toContain('svg');
  });
});

describe('buildProgId / exeBaseName', () => {
  it('should build lowercase ProgID with prefix', () => {
    expect(buildProgId('MP3')).toBe('UrchinBrowser.mp3');
  });

  it('should take the exe file name from a windows path', () => {
    expect(exeBaseName('C:\\Apps\\UrchinBrowser.exe')).toBe('UrchinBrowser.exe');
    expect(exeBaseName('C:/Apps/UrchinBrowser.exe')).toBe('UrchinBrowser.exe');
  });
});

describe('buildAppRegistryEntries', () => {
  it('should register Applications\\<exe>, capabilities and RegisteredApplications', () => {
    const entries = buildAppRegistryEntries(EXE);
    const lines = entries.map((e) => `${e.key}|${e.valueName}|${e.value}`);

    expect(lines).toContain('HKCU\\Software\\Classes\\Applications\\urchin.exe|/d|顽童浏览器');
    expect(lines).toContain(
      'HKCU\\Software\\Classes\\Applications\\urchin.exe|FriendlyAppName|顽童浏览器',
    );
    expect(lines.some((l) => l.startsWith(`${CAPABILITIES_KEY}|ApplicationName|`))).toBe(true);
    expect(
      lines.some(
        (l) =>
          l ===
          'HKCU\\Software\\RegisteredApplications|UrchinBrowser|Software\\Clients\\StartMenuInternet\\UrchinBrowser\\Capabilities',
      ),
    ).toBe(true);
  });

  it('should carry dev launch args into the open command', () => {
    const entries = buildAppRegistryEntries(EXE, ['C:\\app']);
    const command = entries.find((e) =>
      e.key.endsWith('Applications\\urchin.exe\\shell\\open\\command'),
    );
    expect(command?.value).toBe('"C:\\apps\\urchin.exe" "C:\\app" "%1"');
  });
});

describe('buildExtensionEntries', () => {
  it('should build ProgID + OpenWithProgids + capabilities entries', () => {
    const entries = buildExtensionEntries('mp3', EXE);
    const lines = entries.map((e) => `${e.key}|${e.valueName}|${e.value}`);

    // ProgID 归属应用（系统据此把它归到「顽童浏览器」名下）
    expect(lines).toContain(
      'HKCU\\Software\\Classes\\UrchinBrowser.mp3\\Application|ApplicationName|顽童浏览器',
    );
    // 打开命令
    expect(
      lines
        .find((l) => l.includes('UrchinBrowser.mp3\\shell\\open\\command'))
        ?.split('|')
        .at(-1),
    ).toBe('"C:\\apps\\urchin.exe" "%1"');
    // 传统「打开方式」候选
    expect(lines).toContain('HKCU\\Software\\Classes\\.mp3\\OpenWithProgids|UrchinBrowser.mp3|');
    // Win10/11「默认应用」候选
    expect(lines).toContain(`${CAPABILITIES_KEY}\\FileAssociations|.mp3|UrchinBrowser.mp3`);
  });

  it('should NOT write the .ext default value (non-invasive model)', () => {
    // 回归：旧实现写 HKCU\Software\Classes\.ext 默认值 = ProgID，等于静默劫持，
    // 且 Win10/11 有 UserChoice 时被忽略——用户会以为「点了没用」。
    for (const ext of ['mp3', 'mp4', 'png', 'pdf', 'txt']) {
      const entries = buildExtensionEntries(ext, EXE);
      expect(entries.some((e) => e.key === `HKCU\\Software\\Classes\\.${ext}`)).toBe(false);
    }
  });

  it('should normalize leading dot and uppercase', () => {
    const entries = buildExtensionEntries('.MP3', EXE);
    expect(entries.some((e) => e.key.includes('UrchinBrowser.mp3'))).toBe(true);
  });

  it('should be exposed by the legacy buildRegistryEntries alias', () => {
    expect(buildRegistryEntries('mp3', EXE)).toEqual(buildExtensionEntries('mp3', EXE));
  });
});

describe('buildAllRegistryEntries', () => {
  it('should write app entries once and dedupe extensions', () => {
    const entries = buildAllRegistryEntries(['mp3', 'mp3', 'mp4'], EXE);
    const appEntries = buildAppRegistryEntries(EXE).length;
    expect(entries).toHaveLength(appEntries + 2 * buildExtensionEntries('mp3', EXE).length);
    // 应用级条目只写一次
    expect(entries.filter((e) => e.key === 'HKCU\\Software\\RegisteredApplications')).toHaveLength(
      1,
    );
  });
});

describe('buildOpenCommand', () => {
  it('should append dev launch args before %1', () => {
    expect(buildOpenCommand('C:\\a.exe', ['C:\\app'])).toBe('"C:\\a.exe" "C:\\app" "%1"');
  });

  it('should keep packaged command unchanged without launch args', () => {
    expect(buildOpenCommand('C:\\a.exe')).toBe('"C:\\a.exe" "%1"');
  });
});

describe('buildDefaultBrowserRegistryEntries', () => {
  it('should register capabilities, url associations and RegisteredApplications', () => {
    const entries = buildDefaultBrowserRegistryEntries(EXE);
    const byKey = entries.map((entry) => `${entry.key}|${entry.valueName}|${entry.value}`);
    expect(byKey.some((line) => line.includes('Classes\\UrchinHTML\\shell\\open\\command'))).toBe(
      true,
    );
    expect(byKey.some((line) => line.includes('URLAssociations|http|UrchinHTML'))).toBe(true);
    expect(byKey.some((line) => line.includes('URLAssociations|https|UrchinHTML'))).toBe(true);
    expect(byKey.some((line) => line.includes('RegisteredApplications|UrchinBrowser|'))).toBe(true);
    expect(byKey.some((line) => line.includes('FileAssociations|.html|UrchinHTML'))).toBe(true);
  });

  it('should also register the app entry (opening via default-apps page needs it)', () => {
    const entries = buildDefaultBrowserRegistryEntries(EXE);
    expect(entries.some((e) => e.key === 'HKCU\\Software\\Classes\\Applications\\urchin.exe')).toBe(
      true,
    );
  });

  it('should point the default-apps settings URI at the per-user app name', () => {
    expect(buildDefaultAppsSettingsUri()).toBe(
      'ms-settings:defaultapps?registeredAppUser=UrchinBrowser',
    );
  });
});

describe('buildExtensionRemovals / buildAppRemovals', () => {
  it('should only target this app native values', () => {
    const removals = buildExtensionRemovals('mp3');
    expect(removals).toEqual([
      { key: `${CAPABILITIES_KEY}\\FileAssociations`, valueName: '.mp3' },
      { key: 'HKCU\\Software\\Classes\\.mp3\\OpenWithProgids', valueName: 'UrchinBrowser.mp3' },
      { key: 'HKCU\\Software\\Classes\\UrchinBrowser.mp3', valueName: null },
    ]);
    // 不直接删整个 .mp3 键（那是别的应用的登记）
    expect(removals.some((r) => r.key === 'HKCU\\Software\\Classes\\.mp3')).toBe(false);
  });

  it('should remove the app-level keys for the given exe', () => {
    const removals = buildAppRemovals(EXE);
    const keys = removals.map((r) => r.key);
    expect(keys).toContain('HKCU\\Software\\Classes\\Applications\\urchin.exe');
    expect(keys).toContain('HKCU\\Software\\Clients\\StartMenuInternet\\UrchinBrowser');
    expect(keys).toContain('HKCU\\Software\\Classes\\UrchinHTML');
  });
});

describe('buildRegAddArgs / buildRegDeleteArgs', () => {
  it('should put a single /f at the end for named values', () => {
    // 回归：旧实现生成 add KEY /f /v ... /f，reg.exe 报「无效语法」，
    // 导致默认应用页所有按钮 100% 失败。
    expect(
      buildRegAddArgs({ key: 'HKCU\\Software\\Classes\\.mp3', valueName: 'x', value: 'y' }),
    ).toEqual(['add', 'HKCU\\Software\\Classes\\.mp3', '/v', 'x', '/t', 'REG_SZ', '/d', 'y', '/f']);
  });

  it('should use /ve for default values and keep /f last', () => {
    const args = buildRegAddArgs({
      key: 'HKCU\\Software\\Classes\\.mp3',
      valueName: '/d',
      value: 'UrchinBrowser.mp3',
    });
    expect(args).toEqual([
      'add',
      'HKCU\\Software\\Classes\\.mp3',
      '/ve',
      '/d',
      'UrchinBrowser.mp3',
      '/f',
    ]);
    expect(args.filter((arg) => arg === '/f')).toHaveLength(1);
    expect(args.at(-1)).toBe('/f');
  });

  it('should build delete args for whole key / default value / named value', () => {
    expect(buildRegDeleteArgs({ key: 'HKCU\\A', valueName: null })).toEqual([
      'delete',
      'HKCU\\A',
      '/f',
    ]);
    expect(buildRegDeleteArgs({ key: 'HKCU\\A', valueName: '/ve' })).toEqual([
      'delete',
      'HKCU\\A',
      '/ve',
      '/f',
    ]);
    expect(buildRegDeleteArgs({ key: 'HKCU\\A', valueName: 'x' })).toEqual([
      'delete',
      'HKCU\\A',
      '/v',
      'x',
      '/f',
    ]);
  });
});

describe('parseCapabilityExtensions', () => {
  it('should parse reg query output into ext → progId', () => {
    const stdout = [
      'HKEY_CURRENT_USER\\Software\\Clients\\StartMenuInternet\\UrchinBrowser\\Capabilities\\FileAssociations',
      '    .mp3    REG_SZ    UrchinBrowser.mp3',
      '    .mp4    REG_SZ    UrchinBrowser.mp4',
      '',
    ].join('\r\n');
    const map = parseCapabilityExtensions(stdout);
    expect(map.get('mp3')).toBe('UrchinBrowser.mp3');
    expect(map.get('mp4')).toBe('UrchinBrowser.mp4');
    expect(map.size).toBe(2);
  });

  it('should ignore the localized (default) value line', () => {
    const stdout = ['    (默认)    REG_SZ    something'].join('\r\n');
    expect(parseCapabilityExtensions(stdout).size).toBe(0);
  });
});

describe('parseOpenArgs', () => {
  it('should split urls and files, skipping argv0', () => {
    const req = parseOpenArgs(['C:\\apps\\urchin.exe', 'https://example.com', 'C:\\docs\\a.pdf']);
    expect(req.urls).toEqual(['https://example.com']);
    expect(req.files).toEqual(['C:\\docs\\a.pdf']);
  });

  it('should skip the app directory passed by electron in dev mode', () => {
    // 回归：`electron <appDir> <file>` / `"exe" "<appDir>" "%1"` 时 argv[1] 是应用目录，
    // 旧实现只跳过 argv[0]，把 appDir 当文件交给查看器 → 打开图片/视频必失败。
    const req = parseOpenArgs(
      [
        'C:\\node_modules\\electron\\dist\\electron.exe',
        'G:\\pj\\Urchin-Browser\\apps\\desktop',
        'C:\\a.png',
      ],
      'G:\\pj\\Urchin-Browser\\apps\\desktop',
    );
    expect(req.files).toEqual(['C:\\a.png']);
  });

  it('should compare app path case-insensitively and with either separator', () => {
    const req = parseOpenArgs(
      ['electron.exe', 'G:/PJ/Urchin-Browser/apps/desktop/', 'C:\\a.mp4'],
      'g:\\pj\\urchin-browser\\apps\\desktop',
    );
    expect(req.files).toEqual(['C:\\a.mp4']);
  });

  it('should keep relative bare names out (electron internal args)', () => {
    const req = parseOpenArgs(['electron.exe', '--no-sandbox', 'index.html']);
    expect(req.files).toEqual([]);
    expect(req.urls).toEqual([]);
  });

  it('should dedupe repeated arguments', () => {
    const req = parseOpenArgs(['exe', 'C:\\a.png', 'C:\\a.png']);
    expect(req.files).toEqual(['C:\\a.png']);
  });

  it('should skip "." and ".."', () => {
    const req = parseOpenArgs(['exe', '.', '..']);
    expect(req.files).toEqual([]);
  });
});

describe('parseUrlArg', () => {
  it('should return first http/https argument and skip argv0', () => {
    expect(parseUrlArg(['C:\\apps\\urchin.exe', 'https://example.com/a'])).toBe(
      'https://example.com/a',
    );
    expect(parseUrlArg(['urchin.exe', '--flag', 'http://example.com'])).toBe('http://example.com');
  });

  it('should return null for file paths and no url', () => {
    expect(parseUrlArg(['urchin.exe', 'C:\\docs\\a.pdf'])).toBeNull();
    expect(parseUrlArg(['urchin.exe'])).toBeNull();
  });
});

describe('parseFileArg', () => {
  it('should return null when no file argument', () => {
    expect(parseFileArg(['C:\\apps\\urchin.exe'])).toBeNull();
    expect(parseFileArg(['C:\\apps\\urchin.exe', '--flag'])).toBeNull();
  });

  it('should skip argv0 (exe path) and return file path', () => {
    expect(parseFileArg(['C:\\apps\\urchin.exe', 'C:\\docs\\a.pdf'])).toBe('C:\\docs\\a.pdf');
  });

  it('should skip the dev app directory when appPath is given', () => {
    expect(parseFileArg(['exe', 'C:\\app', 'C:\\docs\\a.pdf'], 'C:\\app')).toBe('C:\\docs\\a.pdf');
  });

  it('should parse file:// URL with slashes', () => {
    expect(parseFileArg(['exe', 'file:///C:/docs/a.pdf'])).toBe('C:\\docs\\a.pdf');
  });

  it('should parse file:// URL without slashes', () => {
    expect(parseFileArg(['exe', 'file://C:/docs/a.pdf'])).toBe('C:\\docs\\a.pdf');
  });

  it('should be case-insensitive for File:// prefix', () => {
    expect(parseFileArg(['exe', 'File:///C:/x.mp3'])).toBe('C:\\x.mp3');
  });

  it('should decode percent-encoded path', () => {
    expect(parseFileArg(['exe', 'file:///C:/%E6%96%B0%E5%BB%BA%20folder/a.mp3'])).toBe(
      'C:\\新建 folder\\a.mp3',
    );
  });

  it('should ignore option-like args before the file', () => {
    expect(parseFileArg(['exe', '--no-sandbox', 'D:\\data\\b.json'])).toBe('D:\\data\\b.json');
  });

  it('should return null for web URLs', () => {
    expect(parseFileArg(['exe', 'https://example.com'])).toBeNull();
  });
});
