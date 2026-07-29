// lint-staged 配置
// 依据：agents.md §九 全流程卡点（提交时卡点）/ 03-技术栈 §2 (SC8)
// 顺序：ESLint → Prettier → 相关单测
//
// 注意：eslint.config.js 的 ignores 排除了 **/*.config.{js,ts} 和 .lintstagedrc.js。
// eslint 9 对显式传入被忽略文件的路径会报 "No files matching"。
// 因此用函数过滤：config 文件只走 prettier，非 config 的 ts/tsx 才走 eslint。
const isConfigFile = (f) => /\.config\.(ts|js)$/.test(f) || f.endsWith('.lintstagedrc.js');

export default {
  '*.{ts,tsx}': (files) => {
    const eslintTargets = files.filter((f) => !isConfigFile(f));
    const prettierTargets = files;
    const tasks = [];
    if (eslintTargets.length > 0) {
      tasks.push(`eslint --fix ${eslintTargets.join(' ')}`);
    }
    tasks.push(`prettier --write ${prettierTargets.join(' ')}`);
    return tasks;
  },
  '*.{js,cjs,mjs}': ['prettier --write'],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
