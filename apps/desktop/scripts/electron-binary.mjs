/**
 * 为开发/验收启动准备带品牌图标的 Electron 可执行文件。
 *
 * 背景（用户指令 2026-11-02）：`pnpm start` 直接启动 node_modules 里的
 * electron.exe，Windows 任务管理器按**可执行文件内嵌图标**显示每个进程
 * （主进程 / GPU / renderer / utility 都是同一个 exe），因此全部显示 Electron
 * 原生图标。运行时 API（BrowserWindow icon / setAppUserModelId）只影响窗口与
 * 任务栏，改不了任务管理器里的进程图标。
 *
 * 方案：在同目录复制一份 electron.exe（保持 resources 相对路径不变），用
 * resedit（纯 JS PE 资源编辑器，electron-builder 26 内部同样使用）写入
 * build/icon.ico。子进程由 Chromium 通过 process.execPath 拉起，自动继承该
 * 图标。原 electron.exe 不动；复制失败或资源注入失败时回退原 exe，不影响启动。
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, '..');

/**
 * 返回本次启动应使用的 Electron 可执行文件路径。
 * Windows 上优先返回注入品牌图标的副本；其他平台或失败时返回原路径。
 */
export function resolveElectronBinary() {
  const electronDist = join(appRoot, 'node_modules', 'electron', 'dist');
  const source =
    process.platform === 'win32'
      ? join(electronDist, 'electron.exe')
      : join(electronDist, 'electron');
  if (!existsSync(source)) return source;
  if (process.platform !== 'win32') return source;

  const branded = join(electronDist, 'UrchinBrowser.exe');
  const icon = join(appRoot, 'build', 'icon.ico');
  if (!existsSync(icon)) return source;

  try {
    if (existsSync(branded)) {
      const brandedTime = statSync(branded).mtimeMs;
      if (brandedTime >= statSync(source).mtimeMs && brandedTime >= statSync(icon).mtimeMs) {
        return branded;
      }
    }

    const require = createRequire(import.meta.url);
    const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');

    copyFileSync(source, branded);
    const exe = NtExecutable.from(readFileSync(branded), { ignoreCert: true });
    const res = NtExecutableResource.from(exe);

    // 语言跟随 electron.exe 的版本资源（通常是 en-US 1033），无版本资源时用 1033。
    const versionInfos = Resource.VersionInfo.fromEntries(res.entries);
    const translation = versionInfos[0]?.getAllLanguagesForStringValues()[0] ?? {
      lang: 0x0409,
      codepage: 1200,
    };

    const iconFile = Data.IconFile.from(readFileSync(icon));
    const iconDatas = iconFile.icons.map((item) => item.data);
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, translation.lang, iconDatas);

    if (versionInfos[0]) {
      versionInfos[0].setStringValues(translation, {
        ProductName: '顽童浏览器',
        FileDescription: '顽童浏览器 (Urchin Browser)',
      });
      versionInfos[0].outputToResourceEntries(res.entries);
    }

    res.outputResource(exe);
    writeFileSync(branded, Buffer.from(exe.generate()));
    return branded;
  } catch (error) {
    // 品牌副本写坏会让应用直接启动失败：删除并回退原 exe。
    try {
      if (existsSync(branded)) unlinkSync(branded);
    } catch {
      /* 清理由下一次启动重试 */
    }
    console.warn('[launch] 品牌图标注入失败，回退 electron.exe:', error?.message ?? error);
    return source;
  }
}
