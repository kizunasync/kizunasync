import stylistic from '@stylistic/eslint-plugin'
import babelParser from '@babel/eslint-parser'
import vueParser from 'vue-eslint-parser'
import bodyCommentSingleLine from './eslint/rules/body-comment-single-line.js'
import docCommentAttached from './eslint/rules/doc-comment-attached.js'
import documentedMemberSpacing from './eslint/rules/documented-member-spacing.js'
import singleLineImport from './eslint/rules/single-line-import.js'

/**
 * The repository's JavaScript and TypeScript style gate, run by `bun run lint:js`
 * and by `bun run check`. It carries the five mechanical rules of CONVENTIONS.md
 * "TypeScript & code style", the four shape-limit rules of the same section
 * (complexity, max-depth, max-params, max-lines-per-function) on production code,
 * and nothing else: no recommended preset, so a report here is always one of
 * these nine rules, never a taste imported from a shared config. The shape-limit
 * rules are plain ESLint core rules, not `kizunasync/*` house rules, and are the only
 * ones exempt on test and harness files (SHAPE_EXEMPT_FILES). Rust keeps its own
 * gate in `bun run lint` (Clippy).
 *
 * Babel parses the TypeScript, not typescript-eslint: the latter reads the legacy
 * compiler API, which the `typescript` 7 package does not ship. These rules are
 * syntactic and need no type information.
 */
const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/generated/**',
  '**/Generated/**',
  '**/*.generated.ts',
  '**/wasm/**',
  '**/*.d.ts',
  'target/**',
  '**/.next/**',
  '**/.expo/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/coverage/**',
]

/**
 * Test and harness files: the shape-limit rules below do not apply here, since a
 * table-driven conflict matrix or a conformance fixture legitimately outgrows a
 * production function's size without becoming harder to follow.
 */
const SHAPE_EXEMPT_FILES = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/tests/**',
  '**/conformance/**',
  '**/test-helpers.*',
  '**/test-support.*',
  'packages/protocol/harness/**',
]

const SHAPE_RULES = {
  complexity: ['error', 10],
  'max-depth': ['error', 3],
  'max-params': ['error', 4],
}

const SHAPE_RULES_FUNCTION = {
  ...SHAPE_RULES,
  'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
}

const SHAPE_RULES_COMPONENT = {
  ...SHAPE_RULES,
  'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
}

const PLUGINS = {
  '@stylistic': stylistic,
  kizunasync: {
    rules: {
      'doc-comment-attached': docCommentAttached,
      'documented-member-spacing': documentedMemberSpacing,
      'body-comment-single-line': bodyCommentSingleLine,
      'single-line-import': singleLineImport,
    },
  },
}

const RULES = {
  '@stylistic/padding-line-between-statements': [
    'error',
    { blankLine: 'always', prev: '*', next: ['return', 'throw', 'if', 'for', 'while', 'do', 'switch', 'try'] },
    { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
    { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
    { blankLine: 'any', prev: 'block-like', next: '*' },
  ],
  'kizunasync/doc-comment-attached': 'error',
  'kizunasync/documented-member-spacing': 'error',
  'kizunasync/body-comment-single-line': 'error',
  'kizunasync/single-line-import': 'error',
}

/**
 * Babel parser options for one TypeScript flavour. Babel 8 replaced the preset's
 * `allExtensions`/`isTSX` pair: `ignoreExtensions` parses any extension as
 * TypeScript, which a `.vue` script block needs, and JSX is a separate syntax
 * plugin rather than a preset option.
 */
function babelLanguageOptions(isTSX) {
  return {
    parser: babelParser,
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: {
      requireConfigFile: false,
      babelOptions: {
        presets: [['@babel/preset-typescript', { ignoreExtensions: true }]],
        plugins: isTSX ? ['@babel/plugin-syntax-jsx'] : [],
      },
    },
  }
}

export default [
  { ignores: IGNORES },
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: babelLanguageOptions(false),
    plugins: PLUGINS,
    rules: RULES,
  },
  {
    files: ['**/*.tsx'],
    languageOptions: babelLanguageOptions(true),
    plugins: PLUGINS,
    rules: RULES,
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: PLUGINS,
    rules: RULES,
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
    plugins: PLUGINS,
    rules: RULES,
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        parser: babelParser,
        requireConfigFile: false,
        babelOptions: {
          presets: [['@babel/preset-typescript', { ignoreExtensions: true }]],
        },
      },
    },
    plugins: PLUGINS,
    rules: RULES,
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    ignores: SHAPE_EXEMPT_FILES,
    languageOptions: babelLanguageOptions(false),
    rules: SHAPE_RULES_FUNCTION,
  },
  {
    files: ['**/*.tsx'],
    ignores: SHAPE_EXEMPT_FILES,
    languageOptions: babelLanguageOptions(true),
    rules: SHAPE_RULES_COMPONENT,
  },
  {
    files: ['**/*.{js,mjs}'],
    ignores: SHAPE_EXEMPT_FILES,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: SHAPE_RULES_FUNCTION,
  },
  {
    files: ['**/*.cjs'],
    ignores: SHAPE_EXEMPT_FILES,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
    rules: SHAPE_RULES_FUNCTION,
  },
  {
    files: ['**/*.vue'],
    ignores: SHAPE_EXEMPT_FILES,
    languageOptions: {
      parser: vueParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        parser: babelParser,
        requireConfigFile: false,
        babelOptions: {
          presets: [['@babel/preset-typescript', { ignoreExtensions: true }]],
        },
      },
    },
    rules: SHAPE_RULES_COMPONENT,
  },
]
