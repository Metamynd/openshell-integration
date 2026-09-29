import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/', 'state/'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
  },
];
