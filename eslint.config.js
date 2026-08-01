'use strict';

const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'warn',
    },
  },
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**'],
  },
];
