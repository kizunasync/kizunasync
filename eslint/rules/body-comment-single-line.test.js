import { RuleTester } from 'eslint'
import { test } from 'bun:test'
import babelParser from '@babel/eslint-parser'
import rule from './body-comment-single-line.js'

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

test('body-comment-single-line', () => {
  ruleTester.run('body-comment-single-line', rule, {
    valid: [
      // A single // line comment inside a body is the normal, expected shape.
      `function foo() {
  // a single note
  return 1
}`,
      // A doc block above a function declaration documents the declaration, not the body: out of scope.
      `/**
 * doc
 */
export function foo() {}`,
      // A doc block above a class method: ClassBody stops the body walk, so this is out of scope too.
      `class C {
  /**
   * doc
   */
  method() {}
}`,
      // A MARK marker is protected: it never joins a run, and the note after it starts its own run of one.
      `function foo() {
  // MARK: - Section
  // a normal note
  return 1
}`,
      // Two // comments separated by a statement are not on consecutive lines, so they never form a run.
      `function foo() {
  // first
  doSomething()
  // second
  return 1
}`,
    ],
    invalid: [
      {
        // A single-line block comment in a body is still block form: flattened to a // line.
        code: `function foo() {
  /* explains this */
  return 1
}`,
        output: `function foo() {
  // explains this
  return 1
}`,
        errors: [{ messageId: 'notSingleLine' }],
      },
      {
        // A multi-line JSDoc-style block comment in a body is flattened to one // line.
        code: `function foo() {
  /**
   * multi
   * line
   */
  return 1
}`,
        output: `function foo() {
  // multi line
  return 1
}`,
        errors: [{ messageId: 'notSingleLine' }],
      },
      {
        // Two consecutive // lines read as a wrapped doc comment: reported as one violation, joined by the fix.
        code: `function foo() {
  // first line
  // second line
  return 1
}`,
        output: `function foo() {
  // first line second line
  return 1
}`,
        errors: [{ messageId: 'notSingleLine' }],
      },
      {
        // A run longer than two lines is still one violation spanning the whole run.
        code: `function foo() {
  // one
  // two
  // three
  return 1
}`,
        output: `function foo() {
  // one two three
  return 1
}`,
        errors: [{ messageId: 'notSingleLine' }],
      },
      {
        // A block comment trailing on a statement's own line is not on its own line: reported, not autofixed.
        code: `function foo() {
  doSomething() /* note */
  return 1
}`,
        output: null,
        errors: [{ messageId: 'notSingleLine' }],
      },
    ],
  })
})
