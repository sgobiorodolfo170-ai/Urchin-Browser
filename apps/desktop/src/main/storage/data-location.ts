/**
 * M8 存储层 · 数据目录定位与迁移
 *
 * 职责：
 * 1. 维护数据目录指针文件 data-location.json（位于 userData 根，独立于任何
 *    SQLite 库——避免「设置存在库里、库存在数据目录里」的循环依赖）
 * 2. 启动时按指针解析生效数据目录；指针带 migrateFrom 时整体复制迁移后清标记
 * 3. 升级迁移（一次性）：将旧布局（data/ai.db、data/secrets、data/providers、
 *    userData/summaries）整理进「数据目录 + userData/pi 隔离」新布局
 *
 * 目录架构（DD1 决策）：
 *   userData/data    —— 用户个人数据（可配置，书签/历史/设置/摘要/截图/下载/网页保存）
 *   userData/pi      —— pi(AI) 数据与设置（固定不可配置：ai.db / secrets / providers）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点）：
 * - 指针文件用 JSON 落盘 userData 根：数据目录变更只需写一次文件、重启生效，
 *   迁移（migrateFrom → 新路径）在下次启动时执行，避免阻塞 UI 的长同步操作
 * - 复制而非移动：迁移失败可回退（旧目录保留到迁移成功后清理）
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { createLogger } from '@urchin/logger';

const log = createLogger('data-location');

/** 数据目录指针文件名（位于 userData 根） */
const POINTER_FILE = 'data-location.json';

/** 默认数据目录名（相对 userData） */
const DEFAULT_DATA_DIR_NAME = 'data';

/** pi(AI) 数据目录名（固定相对 userData，不随 data.directory 配置变动） */
export const PI_DIR_NAME = 'pi';

/** 数据目录下按功能预创建的子目录（选定/解析数据目录后自动创建） */
const DATA_SUBDIRS: readonly string[] = [
  'cookies', // 网站 cookies / 网页存储（sessionData 重定向）
  'screenshots', // 截图
  'summaries', // 摘要文档
  'pages', // 网页保存（预留）
  'downloads', // 默认下载目录
  'extensions', // 扩展命名空间 db
];

/** 指针文件内容 */
interface DataLocationFile {
  /** 生效的数据目录绝对路径 */
  path: string;
  /** 待迁移的旧目录（迁移完成后清除）；undefined = 无待迁移 */
  migrateFrom?: string;
}

/** 确保数据目录存在，并预创建各功能子目录。 */
function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const sub of DATA_SUBDIRS) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
}

/** 读取指针文件；不存在或损坏时返回 null（回退默认目录）。 */
function readPointer(userDataPath: string): DataLocationFile | null {
  const file = join(userDataPath, POINTER_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DataLocationFile>;
    if (typeof parsed.path === 'string' && parsed.path.trim()) {
      return { path: parsed.path.trim(), migrateFrom: parsed.migrateFrom };
    }
  } catch (err) {
    log.warn('data-location pointer unreadable, fallback to default', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/** 写入指针文件。 */
function writePointer(userDataPath: string, file: DataLocationFile): void {
  const target = join(userDataPath, POINTER_FILE);
  writeFileSync(target, JSON.stringify(file, null, 2), 'utf8');
}

/**
 * 解析生效的数据目录绝对路径。
 *
 * - 无指针：默认 <defaultRoot>/data（defaultRoot = 软件根目录，DD1 决策；
 *   旧版默认 userData/data，若其中已有用户数据则整体迁入新默认后清理旧目录）
 * - 有指针且 migrateFrom 有效：将旧目录整体复制到新路径（仅当新路径不存在），
 *   成功后清除 migrateFrom 标记——下次启动不再迁移
 * - 确保目录存在后返回
 *
 * 注意：调用前应先执行 migrateLegacyPiData，把旧 userData/data 中的
 * ai.db/secrets/providers 挪入 userData/pi，避免被整体迁移带进新默认目录。
 */
export function resolveDataLocation(userDataPath: string, defaultRoot: string): string {
  const pointer = readPointer(userDataPath);
  if (pointer) {
    const target = resolve(pointer.path);
    if (pointer.migrateFrom?.trim()) {
      const from = resolve(pointer.migrateFrom.trim());
      if (from !== target && existsSync(from) && !existsSync(target)) {
        log.info('migrating data directory', { from, to: target });
        mkdirSync(dirname(target), { recursive: true });
        cpSync(from, target, { recursive: true });
        // 迁移成功后清理旧目录 + 清标记（避免下次启动重复迁移）
        rmSync(from, { recursive: true, force: true });
        writePointer(userDataPath, { path: target });
        log.info('data directory migration completed');
      } else {
        // 迁移源不存在或目标已存在：清标记，保持当前目标
        writePointer(userDataPath, { path: target });
      }
    }
    ensureDataDir(target);
    return target;
  }

  const def = resolve(join(defaultRoot, DEFAULT_DATA_DIR_NAME));
  // 旧版默认目录（userData/data）已有用户数据 → 整体迁入新默认后清理
  const legacy = join(userDataPath, DEFAULT_DATA_DIR_NAME);
  if (legacy !== def && existsSync(legacy) && !existsSync(def)) {
    log.info('migrating legacy default data directory', { from: legacy, to: def });
    mkdirSync(dirname(def), { recursive: true });
    cpSync(legacy, def, { recursive: true });
    rmSync(legacy, { recursive: true, force: true });
  }
  ensureDataDir(def);
  return def;
}

/**
 * 设置新的数据目录（重启生效）。
 *
 * 校验：路径非空、绝对、可创建（权限不足/非法路径抛错由调用方处理）。
 * 写入指针 { path: newPath, migrateFrom: 当前目录 }，下次启动执行整体迁移。
 *
 * @param userDataPath userData 根
 * @param currentDir 当前生效的数据目录（作为迁移源）
 * @param newPath 用户选择的新目录
 */
export function setDataLocation(userDataPath: string, currentDir: string, newPath: string): void {
  const trimmed = newPath.trim();
  if (!trimmed) {
    throw new Error('Data directory path is empty');
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`Data directory path is not absolute: ${newPath}`);
  }
  const target = resolve(trimmed);
  // 提前创建（含功能子目录），校验路径可写（失败抛错，不让用户保存一个下次启动才爆的路径）
  ensureDataDir(target);
  writePointer(userDataPath, { path: target, migrateFrom: resolve(currentDir) });
  log.info('data directory pointer updated (effective after restart)', {
    from: resolve(currentDir),
    to: target,
  });
}

/**
 * 升级迁移（一次性，仅当目标不存在时执行）——pi 数据部分：
 * 旧布局 userData/data 中的 pi 数据 → userData/pi：
 *   userData/data/ai.db      → userData/pi/ai.db
 *   userData/data/secrets/   → userData/pi/secrets/
 *   userData/data/providers/ → userData/pi/providers/
 *
 * 必须在 resolveDataLocation 之前调用：旧 userData/data 会被整体迁移到新默认
 * 数据目录，先挪走 pi 内容可避免 ai.db 被带进用户数据目录（DD1 隔离）。
 * 幂等：源不存在或目标已存在时跳过对应项。
 */
export function migrateLegacyPiData(userDataPath: string): void {
  const piDir = join(userDataPath, PI_DIR_NAME);
  const moves: readonly { readonly from: string; readonly to: string }[] = [
    { from: join(userDataPath, DEFAULT_DATA_DIR_NAME, 'ai.db'), to: join(piDir, 'ai.db') },
    {
      from: join(userDataPath, DEFAULT_DATA_DIR_NAME, 'secrets'),
      to: join(piDir, 'secrets'),
    },
    {
      from: join(userDataPath, DEFAULT_DATA_DIR_NAME, 'providers'),
      to: join(piDir, 'providers'),
    },
  ];

  for (const { from, to } of moves) {
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true, force: true });
      log.info('legacy pi data migrated', { from, to });
    } catch (err) {
      log.error('legacy pi data migration failed', {
        from,
        to,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * 升级迁移（一次性）——摘要文档部分：
 * 旧 userData/summaries → <dataDir>/summaries（摘要文档属用户个人数据，随数据目录）。
 * 幂等：源不存在或目标已存在时跳过。
 */
export function migrateLegacySummaries(userDataPath: string, dataDir: string): void {
  const from = join(userDataPath, 'summaries');
  const to = join(dataDir, 'summaries');
  if (!existsSync(from) || existsSync(to)) return;
  try {
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
    log.info('legacy summaries migrated', { from, to });
  } catch (err) {
    log.error('legacy summaries migration failed', {
      from,
      to,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
