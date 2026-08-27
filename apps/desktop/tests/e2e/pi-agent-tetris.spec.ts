/**
 * E2E · pi 模块「真实用户使用场景」· 俄罗斯方块（Tetris）+ 真实测试运行 + 修复闭环：
 * 让 pi agent 在隔离目录完整开发一个俄罗斯方块游戏（node:test 测试 + demo 运行），前端同步展示；
 * 随后独立真实运行 `node --test`——若发现 agent 测试缺陷，向 agent 追加修复指令（第二轮），
 * 直到真实测试运行全部通过（联网依赖：共享驱动 PiDriver，见 helpers/pi-agent-driver.ts）。
 *
 * 前置（真实外部依赖，非 CI 确定性）：
 * - 需真实 provider key：运行前设 OPENCODE_API_KEY（provider=opencode-go，模型=MiMo V2.5，
 *   endpoint=opencode.ai/zen/go/v1）；未设则自动 skip（不耗额度/不依赖网络）。
 *
 * 验收信号（机器判定）：
 * 1. pi 启动器 running + pi 页面就绪（注入标记）
 * 2. 前端同步展示：完整 transcript（dump 到文件）+ 工具调用序列（含构建与修复两轮）
 * 3. 真实开发成果：package.json / src/game.js / src/demo.js / test/game.test.js 全部落盘
 * 4. 独立真实测试运行：`node --test` 与 `node src/demo.js` 退出码 0（构建→修复闭环后终态）
 * 5. 全程 0 未捕获 console/page 报错
 *
 * 运行（在 apps/desktop 下，key 经环境变量注入、绝不落盘）：
 *   powershell: `$env:OPENCODE_API_KEY=<key>; npx playwright test tests/e2e/pi-agent-tetris.spec.ts`
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PiDriver } from './helpers/pi-agent-driver';

const hasKey = Boolean(process.env.OPENCODE_API_KEY);
test.skip(!hasKey, '未提供 OPENCODE_API_KEY，跳过真实 agent 开发链路（需真实 provider key）');

const TARGET_FILES = ['package.json', 'src/game.js', 'src/demo.js', 'test/game.test.js'] as const;

const BUILD_PROMPT =
  '请在这个项目目录里用 Node.js 开发一个俄罗斯方块（Tetris）游戏，并完成真实测试运行：' +
  '（1）创建 package.json（name 为 tetris，main 为 src/game.js，scripts.test 为 "node --test"）；' +
  '（2）创建 src/game.js，实现核心逻辑并导出：10×20 网格、7 种方块的旋转/左右移/下移、碰撞检测、' +
  '消行（清除并计分）、下一个方块预览；' +
  '（3）创建 src/demo.js：运行一段演示（初始化棋盘、下落若干块、触发一次消行），打印棋盘状态与分数；' +
  '（4）创建 test/game.test.js：用 node:test 写单测（新棋盘为空、方块放置、碰撞不穿透、消行后行数与分数正确）；' +
  '（5）实际运行 node --test 与 node src/demo.js，验证测试与演示均通过并输出结果；' +
  '（6）用简短中文总结你做了什么。只创建上述文件，不要修改其他文件。';

const FIX_PROMPT =
  '我刚才在项目目录里真实运行了 node --test，发现有测试用例失败。请运行 node --test 看具体失败信息，' +
  '修复失败的测试（或修正被测试发现的产品逻辑缺陷），然后重新运行 node --test 确认全部通过，' +
  '并用简短中文说明你修复了什么。只修改与本项目相关的文件。';

test('pi agent 完整开发俄罗斯方块 + 真实测试运行（含修复闭环），前端同步展示全过程', async () => {
  test.setTimeout(900_000);
  const report: Record<string, unknown> = {};
  const driver = await PiDriver.openAndReady();

  try {
    report.piReady = await driver.waitReady();

    const projectDir = mkdtempSync(join(tmpdir(), 'urchin-pi-tetris-'));
    report.projectDir = projectDir;

    await driver.setCwd(projectDir);

    const model = await driver.selectModel();
    report.modelSelection = model;
    if (model.sel.ok) {
      expect((model.currentModel ?? '').toLowerCase()).toMatch(/mimo|deepseek/);
    }

    // ── 第一轮：开发 Tetris ──
    await driver.typeAndSend(BUILD_PROMPT);
    report.buildPrompt = BUILD_PROMPT;

    const transcriptFile = join(projectDir, '__pi_transcript_dump.txt');
    let done = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 480_000) {
      await driver.captureSnap();
      const allFiles = TARGET_FILES.every((f) => existsSync(join(projectDir, f)));
      const running = await driver.isRunning();
      if (allFiles && !running) {
        done = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    report.buildDone = done;
    report.buildElapsedMs = Date.now() - t0;

    // ── 独立真实测试运行 → 若失败（agent 测试缺陷），进入第二轮修复闭环 ──
    const firstTestRun = driver.runNodeTest(projectDir);
    report.firstTestRun = firstTestRun;
    report.demoRun = driver.runDemo(projectDir);

    let fixed = false;
    if (!firstTestRun.ok) {
      await driver.typeAndSend(FIX_PROMPT);
      report.fixPrompt = FIX_PROMPT;
      const t1 = Date.now();
      while (Date.now() - t1 < 300_000) {
        await driver.captureSnap();
        if (driver.runNodeTest(projectDir).ok) {
          fixed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5_000));
      }
      report.fixed = fixed;
      report.fixElapsedMs = Date.now() - t1;
    }

    report.runElapsedMs = Date.now() - t0;
    report.stepsObserved = driver.transcriptHistory.slice(0, 80);
    report.toolCalls = driver.toolCalls.slice(0, 60);
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
    const gameSource = driver.readFileOrEmpty(projectDir, 'src/game.js');
    const testSource = driver.readFileOrEmpty(projectDir, 'test/game.test.js');
    report.fileContent = {
      package: driver.readFileOrEmpty(projectDir, 'package.json'),
      game: gameSource,
      demo: driver.readFileOrEmpty(projectDir, 'src/demo.js'),
      test: testSource,
    };

    const finalTestRun = driver.runNodeTest(projectDir);
    report.finalTestRun = finalTestRun;
    const errs = await driver.collectErrors();
    report.errors = errs;

    // ── 确定性断言 ──
    expect(done, 'Tetris 目标文件未全部生成（agent 可能未完成）').toBe(true);
    for (const f of TARGET_FILES) {
      expect(existsSync(join(projectDir, f)), `缺少文件: ${f}`).toBe(true);
    }
    expect(pkgName).toBe('tetris');
    expect(gameSource).toContain('export');
    expect(gameSource.length).toBeGreaterThan(800);
    expect(testSource).toContain('test');
    expect(
      finalTestRun.ok,
      'node --test 未全部通过（含修复闭环后仍失败）:\n' + finalTestRun.output,
    ).toBe(true);
    expect(finalTestRun.code).toBe(0);
    expect(driver.runDemo(projectDir).code).toBe(0);
    expect(errs.main, '主窗口未捕获报错:\n' + JSON.stringify(errs.main, null, 2)).toEqual([]);
    expect(errs.pi, 'pi 页面未捕获报错:\n' + JSON.stringify(errs.pi, null, 2)).toEqual([]);
  } finally {
    console.log(
      '\n===== PI AGENT 俄罗斯方块开发 + 真实测试运行（含修复闭环）· 前端展示报告 =====\n' +
        JSON.stringify(report, null, 2) +
        '\n===== 完整过程已写入: ' +
        (typeof report.transcriptFile === 'string' ? report.transcriptFile : '(未写入)') +
        ' =====',
    );
    await driver.close();
  }
});
