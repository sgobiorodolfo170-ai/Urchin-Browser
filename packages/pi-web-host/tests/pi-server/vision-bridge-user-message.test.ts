/**
 * D8 的「用户可见」链路（P2-3）。
 *
 * `vision-bridge.test.ts` 锁的是「抛什么」（畸形 content → 空转写错误，而不是 TypeError）；
 * 本文件锁「怎么到用户」：`buildAttachmentMessages` 在视觉桥转写失败时会 `emit` 一条
 * `notice`，其 `text` / `textEn` 直接进入聊天流（用户可见字段）。
 *
 * 全程 fake runtime：不联网、不起子进程，图片是临时目录里的一张 8 字节 PNG 头。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  buildAttachmentMessages,
  type AttachmentContext,
} from '../../src/pi-server/attachments.js';
import type { ServerMessage } from '../../src/pi-server/protocol.js';
import type { ClientSettings } from '../../src/pi-server/client-state.js';

/** PNG 魔数即可通过 sniffImageMime（内容不被真正解码）。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type NoticeMessage = Extract<ServerMessage, { type: 'notice' }>;

function isNotice(msg: ServerMessage): msg is NoticeMessage {
  return msg.type === 'notice';
}

/**
 * 造一个「只认图、但返回畸形 content」的 runtime。
 *
 * 返回 `{ content: '整段字符串' }` 是 D8 记录的真实 provider 漂移形状：
 * 旧实现会在这里抛 `TypeError: msg.content.filter is not a function`。
 */
function makeMalformedRuntime(): ModelRuntime {
  const runtime = {
    getProviders: () => [{ id: 'prov-1' }],
    hasConfiguredAuth: () => true,
    getModels: () => [{ id: 'vision-1', name: 'Vision One', input: ['text', 'image'] }],
    getModel: () => ({ id: 'vision-1', provider: 'prov-1', input: ['text', 'image'] }),
    completeSimple: () =>
      Promise.resolve({
        role: 'assistant',
        stopReason: 'stop',
        content: '整段文本而不是内容块数组',
        timestamp: 1,
      }),
  };
  // 只实现视觉桥用到的成员；其余成员与 D8 无关，双跳断言成接口（同 vision-bridge.test.ts）
  return runtime as unknown as ModelRuntime;
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-vision-user-'));
  writeFileSync(join(cwd, 'shot.png'), PNG_BYTES);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeContext(notices: ServerMessage[], lang: 'zh' | 'en'): AttachmentContext {
  // 只喂 buildAttachmentMessages 读取的字段；其余由 ClientSettings 的默认值兜底，
  // 这里显式声明为测试替身（与 vision-bridge.test.ts 的 fake runtime 同一手法）。
  const settings = {
    visionBridgeEnabled: true,
    visionBridgeModel: null,
    visionBridgePromptMode: 'append',
    visionBridgePrompt: '',
  } as unknown as ClientSettings;
  const session = {
    model: { id: 'main-text-only', provider: 'prov-main', input: ['text'] },
    modelRuntime: makeMalformedRuntime(),
  } as unknown as AgentSession;
  return {
    cwd,
    clientId: 'test-client',
    emit: (msg) => notices.push(msg),
    settings,
    session,
    getLang: () => lang,
  };
}

/** 跑一次「支持识图的主模型 + 畸形视觉返回」，返回唯一那条 error notice。 */
async function transcribeFailureNotice(lang: 'zh' | 'en'): Promise<NoticeMessage> {
  const notices: ServerMessage[] = [];
  await buildAttachmentMessages(makeContext(notices, lang), [{ path: 'shot.png' }]);
  const errors = notices.filter(isNotice).filter((n) => n.level === 'error');
  expect(errors).toHaveLength(1);
  return errors[0];
}

describe('D8 用户可见文案', () => {
  it('should surface the empty-transcript message to a zh user instead of a TypeError', async () => {
    const notice = await transcribeFailureNotice('zh');
    const text = notice.text;
    // 用户看到的是可诊断的中文文案……
    expect(text).toContain('图片转写失败');
    expect(text).toContain('视觉模型返回了空的转写结果');
    // ……而不是与业务无关的崩溃细节
    expect(text).not.toContain('TypeError');
    expect(text).not.toContain('filter is not a function');
  });

  it('should surface the empty-transcript message to an en user', async () => {
    const notice = await transcribeFailureNotice('en');
    // 英文界面读 textEn（text 恒为中文）
    const textEn = notice.textEn ?? '';
    expect(textEn).toContain('Image transcription failed');
    expect(textEn).toContain('Vision model returned an empty transcript');
    expect(textEn).not.toContain('TypeError');
  });
});
