import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'demo-dist/**', 'artifacts/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.worker } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // Compiler fixtures intentionally load generated CommonJS modules.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  { files: ['demo/**/*.ts'], languageOptions: { globals: { __APP_VERSION__: 'readonly', __BUILD_COMMIT__: 'readonly' } } },
)
