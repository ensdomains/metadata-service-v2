import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        // Web APIs
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        RequestInit: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        CompressionStream: 'readonly',
        DecompressionStream: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        Buffer: 'readonly',

        // Cloudflare Workers APIs
        KVNamespace: 'readonly',
        D1Database: 'readonly',
        R2Bucket: 'readonly',
        DurableObjectNamespace: 'readonly',

        // Node.js globals (for compatibility)
        process: 'readonly',
        global: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript itself checks for undefined identifiers (see `tsc --noEmit`),
      // and `no-undef` produces false positives on both platform globals (Workers
      // Cache API `caches`/`Cache`, `AbortSignal`, `crypto`) and type-only names
      // (`BufferSource`). Disabling it for TS is the typescript-eslint-recommended
      // setup — TS is the source of truth for name resolution.
      'no-undef': 'off',
      // Standard conventions: `_`-prefixed args/vars are intentionally unused, and
      // an unused `catch` binding is not an error.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Allow ambient `declare namespace` (e.g. augmenting the global `Intl` for
      // Intl.Segmenter types) while still banning runtime namespaces.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
];