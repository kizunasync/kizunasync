import { RuleTester } from 'eslint'
import { test } from 'bun:test'
import babelParser from '@babel/eslint-parser'
import rule from './doc-comment-attached.js'

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

test('doc-comment-attached', () => {
  ruleTester.run('doc-comment-attached', rule, {
    valid: [
      // Attached directly above the declaration it documents.
      `/**
 * doc
 */
export function foo() {}`,
      // A lone block comment first in the file is the preamble, even with a gap before what follows.
      `/**
 * File preamble.
 */

import { readFileSync } from 'node:fs'

export const x = readFileSync`,
      // A block comment followed by a MARK marker documents the group below the marker, not the next declaration.
      `export const A = 1

/**
 * Section note.
 */

// MARK: - Section
export function foo() {
  return A
}`,
    ],
    invalid: [
      {
        // A basic declaration separated from its doc block by a blank line.
        code: `export const A = 1

/**
 * doc
 */

export function foo() {
  return A
}`,
        output: `export const A = 1

/**
 * doc
 */
export function foo() {
  return A
}`,
        errors: [{ messageId: 'detached' }],
      },
      {
        // A detached interface method (TSMethodSignature): the `retry` shape.
        code: `export interface IAttachmentClient {
  /**
   * Forgive the transfer budget on one reference: the row goes back to
   * \`queued\` with its attempts cleared, so the next drive takes it again. A
   * reference no row carries is a no-op.
   */

  retry(ref: string): Promise<void>
}`,
        output: `export interface IAttachmentClient {
  /**
   * Forgive the transfer budget on one reference: the row goes back to
   * \`queued\` with its attempts cleared, so the next drive takes it again. A
   * reference no row carries is a no-op.
   */
  retry(ref: string): Promise<void>
}`,
        errors: [{ messageId: 'detached' }],
      },
      {
        // A detached class property (PropertyDefinition).
        code: `export class C {
  /**
   * doc
   */

  x: number
}`,
        output: `export class C {
  /**
   * doc
   */
  x: number
}`,
        errors: [{ messageId: 'detached' }],
      },
    ],
  })
})
