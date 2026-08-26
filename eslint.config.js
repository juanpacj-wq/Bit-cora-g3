// ESLint mínimo (metodología v2, Fase 0): recommended + react-hooks. Baseline congelado el 2026-08-26:
// el gate de cada ola exige "cero errores nuevos" (npm run lint) y el pre-commit corre eslint sobre lo que entra.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'server/node_modules/**', 'js-scraper-carbon-g32/**', 'graphify-out/**'] },
  {
    files: ['src/**/*.{js,jsx}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      // Solo las dos reglas clásicas: las del React Compiler (set-state-in-effect, refs, immutability)
      // requieren refactors y quedan fuera del baseline.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    files: ['server/**/*.{js,mjs}', 'auth/**/*.js', 'vite.config.js', 'vitest.config.js', 'tailwind.config.js', 'postcss.config.js', '.githooks/**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Reglas nuevas de ESLint 9 que piden refactors; quedan en warn hasta que un lote las atienda.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
];
