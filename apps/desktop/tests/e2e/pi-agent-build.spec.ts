/**
 * E2E · pi 模块「真实用户使用场景」· todo-cli：让 pi agent 在隔离目录里完整开发一个实例小项目，
 * 前端同步展示全过程（联网依赖：用共享驱动 PiDriver，见 helpers/pi-agent-driver.ts）。
 *
 * 前置（真实外部依赖，非 CI 确定性）：
 * - 需真实 provider key 注入：运行前设 OPENCODE_API_KEY（provider=opencode-go，模型=MiMo V2.5，
 *   endpoint=opencode.ai/zen/go/v1）；未设则自动 skip（不耗额度/不依赖网络）。
 *
 * 验收信号（机器判定）：
 * 1. pi 启动器 running + pi 页面就绪（注入标记）
 * 2. 前端同步展示：完整 transcript（dump 到文件）+ 工具调用序列
 * 3. 真实开发成果：package.json / index.js / todos.json 全部落盘且内容核验
 * 4. 全程 0 未捕获 console/page 报错
 *
 * 运行（在 apps/desktop 下，key 经环境变量注入、绝不落盘）：
 *   powershell: `$env:OPENCODE_API_KEY=<key>; npx playwright test tests/e2e/pi-agent-build.spec.ts`
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PiDriver } from './helpers/pi-agent-driver';

const hasKey = Boolean(process.env.OPENCODE_API_KEY);
test.skip(!hasKey, '未提供 OPENCODE_API_KEY，跳过真实 agent 开发链路（需真实 provider key）');

const TARGET_FILES = ['package.json', 'index.js', 'todos.json'] as const;
const PROMPT =
  '请在这个项目目录里，用 Node.js 完成一个最小可运行的命令行待办事项小工具（todo-cli）：' +
  '（1）创建 package.json（name 为 todo-cli，main 为 index.js，scripts.start 为 node index.js）；' +
  '（2）创建 index.js：支持 add <任务> 新增、list 列出、done <序号> 标记完成，数据存 todos.json；' +
  '（3）运行 node index.js add 示例任务 和 node index.js list 验证功能可用；' +
  '（4）用简短中文总结你做了什么。只创建上述文件，不要修改其他文件。';

test('pi agent 完整开发 todo-cli 并在前端同步展示全过程', async () => {
  test.setTimeout(900_000);
  const report: Record<string, unknown> = {};
  const driver = await PiDriver.openAndReady();

  try {
    report.piReady = await driver.waitReady();

    const projectDir = mkdtempSync(join(tmpdir(), 'urchin-pi-project-'));
    report.projectDir = projectDir;

    await driver.setCwd(projectDir);

    const model = await driver.selectModel();
    report.modelSelection = model;
    if (model.sel.ok) {
      expect((model.currentModel ?? '').toLowerCase()).toMatch(/mimo|deepseek/);
    }

    await driver.typeAndSend(PROMPT);
    report.prompt = PROMPT;

    const transcriptFile = join(projectDir, '__pi_transcript_dump.txt');
    let done = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 480_000) {
      await driver.captureSnap();
      if (TARGET_FILES.every((f) => existsSync(join(projectDir, f)))) {
        done = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    report.runDone = done;
    report.runElapsedMs = Date.now() - t0;
    report.stepsObserved = driver.transcriptHistory.slice(0, 60);
    report.toolCalls = driver.toolCalls.slice(0, 40);
    report.transcriptFile = (await driver.dumpTranscript(transcriptFile)) ? transcriptFile : null;

    const files = readdirSync(projectDir)
      .map((f) => ({ name: f, size: statSync(join(projectDir, f)).size }))
      .sort((a, b) => a.name.localeCompare(b.name));
    report.files = files;
    const pkgName = ((): string | null => {
      try {
        return (
          (
            JSON.parse(driver.readFileOrEmpty(projectDir, 'package.json') || '{}') as {
              name?: string;
            }
          ).name ?? null
        );
      } catch {
        return null;
      }
    })();
    report.fileContent = {
      package: driver.readFileOrEmpty(projectDir, 'package.json'),
      index: driver.readFileOrEmpty(projectDir, 'index.js'),
      todos: driver.readFileOrEmpty(projectDir, 'todos.json'),
    };
    const errs = await driver.collectErrors();
    report.errors = errs;

    expect(done, 'todo-cli 目标文件未全部生成（agent 可能未完成）').toBe(true);
    expect(existsSync(join(projectDir, 'package.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'index.js'))).toBe(true);
    expect(existsSync(join(projectDir, 'todos.json'))).toBe(true);
    expect(pkgName).toBe('todo-cli');
    expect(driver.readFileOrEmpty(projectDir, 'index.js')).toContain('add');
    expect(errs.main, '主窗口未捕获报错:\n' + JSON.stringify(errs.main, null, 2)).toEqual([]);
    expect(errs.pi, 'pi 页面未捕获报错:\n' + JSON.stringify(errs.pi, null, 2)).toEqual([]);
  } finally {
    console.log(
      '\n===== PI AGENT todo-cli 开发 · 前端展示报告 =====\n' +
        JSON.stringify(report, null, 2) +
        '\n===== 完整过程已写入: ' +
        (typeof report.transcriptFile === 'string' ? report.transcriptFile : '(未写入)') +
        ' =====',
    );
    await driver.close();
  }
});
