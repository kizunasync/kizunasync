/**
 * A doc block belongs to the declaration directly below it. Separated by a blank
 * line it reads as a file preamble or a section note instead, and editors attach
 * it to nothing, so the placement itself carries meaning and is enforced here.
 */

const DECLARATION_TYPES = new Set([
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'FunctionDeclaration',
  'VariableDeclaration',
  'ClassDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSDeclareFunction',
  'TSModuleDeclaration',
  'Decorator',
  'TSPropertySignature',
  'TSMethodSignature',
  'TSIndexSignature',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
  'PropertyDefinition',
  'MethodDefinition',
  'AccessorProperty',
  'TSAbstractPropertyDefinition',
  'TSAbstractMethodDefinition',
])

const MESSAGE = 'Doc comment must sit directly above the declaration or member it documents (no blank line); a file preamble goes above the imports; a group note goes above its MARK marker.'

/**
 * The outermost node starting at `index`, so `export const x` is reported as the
 * export rather than as the inner declaration.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {number} index
 * @returns {import('estree').Node | null}
 */
function outermostNodeAt(sourceCode, index) {
  let node = sourceCode.getNodeByRangeIndex(index)

  while (node?.parent && node.parent.type !== 'Program' && node.parent.range[0] === index) {
    node = node.parent
  }

  return node
}

/**
 * True when the block is the first thing in the file, so it documents the module
 * rather than what follows it. Only a `'use client'`/`'use server'` directive and
 * `/// <reference …>` lines may come first: both must stay at the very top. A file
 * with no imports, a barrel among them, still has a preamble position.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Comment} comment
 * @returns {boolean}
 */
function isFilePreamble(sourceCode, comment) {
  for (const token of sourceCode.getTokensBefore(comment, { includeComments: true })) {
    if (token.type === 'Line' && /^\/\s*<reference\b/.test(token.value)) {
      continue
    }

    if (token.type === 'Punctuator' && token.value === ';') {
      continue
    }

    if (token.type === 'String' && /^['"]use (client|server)['"]$/.test(token.value)) {
      continue
    }

    return false
  }

  return true
}

/**
 * The declaration `comment` must sit directly above, or `null` when the doc
 * block is a file preamble, has no following declaration, or already sits
 * within one blank line of one.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Comment} comment
 * @returns {import('estree').Node | null}
 */
function findDetachedDeclaration(sourceCode, comment) {
  if (isFilePreamble(sourceCode, comment)) {
    return null
  }

  const next = sourceCode.getTokenAfter(comment, { includeComments: true })

  if (!next || next.type === 'Line' || next.type === 'Block') {
    return null
  }

  if (next.loc.start.line - comment.loc.end.line < 2) {
    return null
  }

  const node = outermostNodeAt(sourceCode, next.range[0])

  if (!node || node.range[0] !== next.range[0] || !DECLARATION_TYPES.has(node.type)) {
    return null
  }

  return node
}

/**
 * Reports `comment` as detached from `node`, fixed by collapsing the blank
 * lines between them down to the one line break that keeps them adjacent.
 *
 * @param {import('eslint').Rule.RuleContext} context
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Comment} comment
 * @param {import('estree').Node} node
 */
function reportDetached(context, sourceCode, comment, node) {
  const between = sourceCode.text.slice(comment.range[1], node.range[0])

  context.report({
    loc: comment.loc,
    messageId: 'detached',
    fix: (fixer) => fixer.replaceTextRange([comment.range[1], node.range[0]], `\n${between.split('\n').pop()}`),
  })
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'layout',
    docs: { description: 'Require a doc block to sit directly above the declaration it documents' },
    fixable: 'whitespace',
    schema: [],
    messages: { detached: MESSAGE },
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      'Program:exit': () => {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type !== 'Block' || !comment.value.startsWith('*')) {
            continue
          }

          const node = findDetachedDeclaration(sourceCode, comment)

          if (node) {
            reportDetached(context, sourceCode, comment, node)
          }
        }
      },
    }
  },
}

export default rule
