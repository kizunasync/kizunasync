import { RuleTester } from 'eslint'
import { test } from 'bun:test'
import babelParser from '@babel/eslint-parser'
import rule from './single-line-import.js'

const languageOptions = {
  parser: babelParser,
  ecmaVersion: 'latest',
  sourceType: 'module',
  parserOptions: {
    requireConfigFile: false,
    babelOptions: {
      presets: [['@babel/preset-typescript', { ignoreExtensions: true }]],
      plugins: [],
    },
  },
}

const ruleTester = new RuleTester({ languageOptions })

test('single-line-import', () => {
  ruleTester.run('single-line-import', rule, {
    valid: [
      // Already one line.
      `import { a, b, c } from './m'`,
      // A single-line re-export.
      `export { a, b } from './m'`,
      // A single-line export-all.
      `export * from './m'`,
      // A multi-line declaration with no module source is not an import/re-export at all: out of scope.
      `export const x = {
  a: 1,
  b: 2,
}`,
    ],
    invalid: [
      {
        // A wrapped import is joined onto one line, and the trailing comma before the brace is dropped.
        code: `import {
  a,
  b,
  c,
} from './m'`,
        output: `import { a, b, c } from './m'`,
        errors: [{ messageId: 'multiLine' }],
      },
      {
        // A wrapped re-export is joined the same way.
        code: `export {
  a,
  b,
} from './m'`,
        output: `export { a, b } from './m'`,
        errors: [{ messageId: 'multiLine' }],
      },
      {
        // ExportAllDeclaration gets the same one-line treatment.
        code: `export *
from './m'`,
        output: `export * from './m'`,
        errors: [{ messageId: 'multiLine' }],
      },
      {
        // A comment inside the statement blocks the autofix: joining it would move or drop the comment.
        code: `import {
  a, // needed for x
  b,
} from './m'`,
        output: null,
        errors: [{ messageId: 'multiLine' }],
      },
      {
        // Empty braces collapse to {} rather than { }.
        code: `import {
} from './m'`,
        output: `import {} from './m'`,
        errors: [{ messageId: 'multiLine' }],
      },
    ],
  })
})
