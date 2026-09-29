import { RuleTester } from 'eslint'
import { test } from 'bun:test'
import babelParser from '@babel/eslint-parser'
import rule from './documented-member-spacing.js'

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

test('documented-member-spacing', () => {
  ruleTester.run('documented-member-spacing', rule, {
    valid: [
      // First documented member needs no blank line above its doc block.
      `interface I {
  /**
   * doc
   */
  a(): void

  b(): void
}`,
      // Last documented member needs no blank line below it.
      `interface I {
  a(): void

  /**
   * doc
   */
  b(): void
}`,
      // Undocumented members keep touching.
      `interface I {
  a(): void
  b(): void
  c(): void
}`,
    ],
    invalid: [
      {
        // Documented member in the middle of an interface, packed on both sides.
        code: `interface I {
  a(): void
  /**
   * doc
   */
  b(): void
  c(): void
}`,
        output: `interface I {
  a(): void

  /**
   * doc
   */
  b(): void

  c(): void
}`,
        errors: [{ messageId: 'before' }, { messageId: 'after' }],
      },
      {
        // Documented method between two properties in a class body.
        code: `class C {
  a: number
  /**
   * doc
   */
  b(): void
  c: number
}`,
        output: `class C {
  a: number

  /**
   * doc
   */
  b(): void

  c: number
}`,
        errors: [{ messageId: 'before' }, { messageId: 'after' }],
      },
      {
        // Same shape inside a type literal.
        code: `type T = {
  a: number
  /**
   * doc
   */
  b: number
  c: number
}`,
        output: `type T = {
  a: number

  /**
   * doc
   */
  b: number

  c: number
}`,
        errors: [{ messageId: 'before' }, { messageId: 'after' }],
      },
      {
        // A trailing `// note` stays on the previous member's line; the blank line lands after the note, not before it.
        code: `interface I {
  a(): void // note
  /**
   * doc
   */
  b(): void
}`,
        output: `interface I {
  a(): void // note

  /**
   * doc
   */
  b(): void
}`,
        errors: [{ messageId: 'before' }],
      },
      {
        // A trailing `;` stays on the member's own line on both sides.
        code: `interface I {
  a(): void;
  /**
   * doc
   */
  b(): void;
  c(): void;
}`,
        output: `interface I {
  a(): void;

  /**
   * doc
   */
  b(): void;

  c(): void;
}`,
        errors: [{ messageId: 'before' }, { messageId: 'after' }],
      },
      {
        // A trailing `,` stays on the member's own line on both sides.
        code: `type T = {
  a: number,
  /**
   * doc
   */
  b: number,
  c: number,
}`,
        output: `type T = {
  a: number,

  /**
   * doc
   */
  b: number,

  c: number,
}`,
        errors: [{ messageId: 'before' }, { messageId: 'after' }],
      },
    ],
  })
})
