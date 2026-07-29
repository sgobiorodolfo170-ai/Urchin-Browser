// commitlint 配置
// 依据：agents.md §五 结构化提交信息 / 03-技术栈 §2 (SC9)
// 类型：feat / fix / refactor / test / docs / chore / perf / style / build / ci
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // type 枚举与 agents.md §五 对齐
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'perf', 'style', 'build', 'ci'],
    ],
    // subject 不能为空，最长 100
    'subject-empty': [2, 'never'],
    'subject-max-length': [2, 'always', 100],
    // header 最长 120
    'header-max-length': [2, 'always', 120],
    // body 每行最长 200
    'body-max-line-length': [2, 'always', 200],
    // footer 每行最长 200
    'footer-max-line-length': [2, 'always', 200],
  },
};
