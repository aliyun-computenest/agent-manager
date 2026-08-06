// @ali/eslint-config-rvn 是内部包，仅本地开发时通过内网 registry 安装
// Docker 构建不需要 eslint，缺失时 graceful fallback
let rvnConfig = []
try {
  const { configs } = await import('@ali/eslint-config-rvn')
  rvnConfig = configs.react()
} catch {
  console.warn('[eslint] @ali/eslint-config-rvn not found, using minimal config')
}
import { FlatCompat } from '@eslint/eslintrc'
import { globalIgnores } from 'eslint/config'
import importPlugin from 'eslint-plugin-import'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import unusedImportsPlugin from 'eslint-plugin-unused-imports'
import tseslint from 'typescript-eslint'

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
})

const eslintConfig = [
  ...rvnConfig,
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs}'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: importPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'unused-imports': unusedImportsPlugin,
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs'],
        },
      },
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // ===== 质量规则 =====
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 禁止使用 == / !=，强制使用 === / !==
      eqeqeq: ['error', 'always'],
      // 禁止未使用的变量（忽略以 _ 开头的参数）
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // 禁止使用 any 类型（降为 warn，逐步收敛）
      '@typescript-eslint/no-explicit-any': 'warn',
      // 禁止未使用的 import
      'unused-imports/no-unused-imports': 'error',
      // 禁止在 JSX 中使用数组 index 作为 key
      'react/no-array-index-key': 'warn',
      // 项目中大量使用 console.log 调试，不限制
      'no-console': 'off',
      // 管理平台中 alert/confirm/prompt 是合理的用户交互方式
      'no-alert': 'off',
      'react/no-unused-prop-types': 'off',
      'react/prop-types': 'off',
      // 嵌套三元在 JSX 中较常见，关闭
      'no-nested-ternary': 'off',
      // catch 块中 error 变量遮蔽是正常模式，关闭
      '@typescript-eslint/no-shadow': 'off',
      // parseInt 不强制加基数，项目中普遍使用
      radix: 'off',
      // import 排序纯噪音，关闭
      'import/order': 'off',
      // require-atomic-updates 误报较多，关闭
      'require-atomic-updates': 'off',
      // ===== 分号：项目统一 no-semicolon 风格 =====
      'semi': ['error', 'never'],
      'no-extra-semi': 'error',
      // ===== 关闭所有 @stylistic 格式规则，项目不使用 stylistic 强制格式 =====
      // 逐条关闭 rvn 预设中启用的 @stylistic 规则，避免 auto-fix 改变代码风格
      '@stylistic/array-bracket-newline': 'off',
      '@stylistic/array-bracket-spacing': 'off',
      '@stylistic/array-element-newline': 'off',
      '@stylistic/arrow-parens': 'off',
      '@stylistic/arrow-spacing': 'off',
      '@stylistic/block-spacing': 'off',
      '@stylistic/brace-style': 'off',
      '@stylistic/comma-dangle': 'off',
      '@stylistic/comma-spacing': 'off',
      '@stylistic/comma-style': 'off',
      '@stylistic/computed-property-spacing': 'off',
      '@stylistic/dot-location': 'off',
      '@stylistic/eol-last': 'off',
      '@stylistic/func-call-spacing': 'off',
      '@stylistic/function-paren-newline': 'off',
      '@stylistic/generator-star-spacing': 'off',
      '@stylistic/implicit-arrow-linebreak': 'off',
      '@stylistic/indent': 'off',
      '@stylistic/indent-binary-ops': 'off',
      '@stylistic/jsx-closing-bracket-location': 'off',
      '@stylistic/jsx-curly-brace-presence': 'off',
      '@stylistic/jsx-curly-spacing': 'off',
      '@stylistic/jsx-equals-spacing': 'off',
      '@stylistic/jsx-first-prop-new-line': 'off',
      '@stylistic/jsx-indent': 'off',
      '@stylistic/jsx-indent-props': 'off',
      '@stylistic/jsx-max-props-per-line': 'off',
      '@stylistic/jsx-pascal-case': 'off',
      '@stylistic/jsx-props-no-multi-spaces': 'off',
      '@stylistic/jsx-quotes': 'off',
      '@stylistic/jsx-sort-props': 'off',
      '@stylistic/jsx-tag-spacing': 'off',
      '@stylistic/jsx-wrap-multilines': 'off',
      '@stylistic/key-spacing': 'off',
      '@stylistic/keyword-spacing': 'off',
      '@stylistic/line-comment-position': 'off',
      '@stylistic/linebreak-style': 'off',
      '@stylistic/lines-between-class-members': 'off',
      '@stylistic/lines-around-comment': 'off',
      '@stylistic/max-len': 'off',
      '@stylistic/max-statements-per-line': 'off',
      '@stylistic/member-delimiter-style': 'off',
      '@stylistic/multiline-comment-style': 'off',
      '@stylistic/multiline-ternary': 'off',
      '@stylistic/new-parens': 'off',
      '@stylistic/newline-per-chained-call': 'off',
      '@stylistic/no-confusing-arrow': 'off',
      '@stylistic/no-extra-parens': 'off',
      '@stylistic/no-extra-semi': 'off',
      '@stylistic/no-floating-decimal': 'off',
      '@stylistic/no-mixed-operators': 'off',
      '@stylistic/no-mixed-spaces-and-tabs': 'off',
      '@stylistic/no-multi-spaces': 'off',
      '@stylistic/no-multiple-empty-lines': 'off',
      '@stylistic/no-tabs': 'off',
      '@stylistic/no-trailing-spaces': 'off',
      '@stylistic/no-whitespace-before-property': 'off',
      '@stylistic/nonblock-statement-body-position': 'off',
      '@stylistic/object-curly-newline': 'off',
      '@stylistic/object-curly-spacing': 'off',
      '@stylistic/object-property-newline': 'off',
      '@stylistic/one-var-declaration-per-line': 'off',
      '@stylistic/operator-linebreak': 'off',
      '@stylistic/padded-blocks': 'off',
      '@stylistic/padding-line-between-statements': 'off',
      '@stylistic/quote-props': 'off',
      '@stylistic/quotes': 'off',
      '@stylistic/rest-spread-spacing': 'off',
      '@stylistic/semi': 'off',
      '@stylistic/semi-spacing': 'off',
      '@stylistic/semi-style': 'off',
      '@stylistic/space-before-blocks': 'off',
      '@stylistic/space-before-function-paren': 'off',
      '@stylistic/space-in-parens': 'off',
      '@stylistic/space-infix-ops': 'off',
      '@stylistic/space-unary-ops': 'off',
      '@stylistic/spaced-comment': 'off',
      '@stylistic/switch-colon-spacing': 'off',
      '@stylistic/template-curly-spacing': 'off',
      '@stylistic/template-tag-spacing': 'off',
      '@stylistic/type-annotation-spacing': 'off',
      '@stylistic/wrap-iife': 'off',
      '@stylistic/wrap-regex': 'off',
      '@stylistic/yield-star-spacing': 'off',
      // ===== 关闭 React JSX 格式规则，避免 auto-fix 产生 {' '} 空格拆分等格式噪音 =====
      'react/jsx-closing-bracket-location': 'off',
      'react/jsx-closing-tag-location': 'off',
      'react/jsx-curly-brace-presence': 'off',
      'react/jsx-curly-newline': 'off',
      'react/jsx-curly-spacing': 'off',
      'react/jsx-equals-spacing': 'off',
      'react/jsx-first-prop-new-line': 'off',
      'react/jsx-indent': 'off',
      'react/jsx-indent-props': 'off',
      'react/jsx-max-props-per-line': 'off',
      'react/jsx-newline': 'off',
      'react/jsx-no-literals': 'off',
      'react/jsx-one-expression-per-line': 'off',
      'react/jsx-props-no-multi-spaces': 'off',
      'react/jsx-sort-props': 'off',
      'react/jsx-tag-spacing': 'off',
      'react/jsx-wrap-multilines': 'off',
      // unused-imports/no-unused-vars 与原生规则冲突，关闭插件版本
      'unused-imports/no-unused-vars': 'off',
      // no-useless-escape 降为 warn，不阻断提交
      'no-useless-escape': 'warn',
      // 限制 @ts-ignore 的使用，强制使用 @ts-expect-error 并附带说明
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-ignore': 'allow-with-description',
        'ts-expect-error': 'allow-with-description',
        'ts-nocheck': true,
        minimumDescriptionLength: 10,
      }],
      // 忽略静态资源文件的导入检查
      'import/no-unresolved': ['error', {
        ignore: [
          '\\.svg$',
          '\\.png$',
          '\\.jpg$',
          '\\.jpeg$',
          '\\.gif$',
          '\\.webp$',
          '\\.ico$',
          '\\.woff$',
          '\\.woff2$',
          '\\.ttf$',
          '\\.eot$',
          '^/', // 忽略以 / 开头的路径（Vite 公共资源）
        ],
      }],
    },
  },
  {
    files: ['eslint.config.mjs'],
    rules: {
      'import/no-unresolved': 'off',
    },
  },
  {
    files: ['**/__tests__/**/*.test.[jt]s?(x)'],
    ...compat.extends('plugin:testing-library/react')[0],
    rules: {
      'testing-library/await-async-queries': 'error',
      'testing-library/no-await-sync-queries': 'error',
      'testing-library/no-debugging-utils': 'warn',
      'testing-library/no-dom-import': 'off',
      'testing-library/no-manual-cleanup': 'off',
      'testing-library/no-node-access': 'warn',
      'testing-library/no-render-in-lifecycle': ['error', { allowTestingFrameworkSetupHook: 'beforeEach' }],
    },
  },
  globalIgnores([
    'packages/**/*',
    'build/**/*',
    'dist/**/*',
    'node_modules/**/*',
    'logs/**/*',
    'public/**/*',
    'compiled_scripts/**/*',
    'server/**/*',
    'migrations/**/*',
    'scripts/**/*',
    'data/**/*',
    'playwright-report/**/*',
    'tests/**/*',
    'playwright.config.ts',
    'venv/**/*',
    '.vite/**/*',
    'docker/**/*',
  ], 'Ignore Directories'),
]

export default eslintConfig
