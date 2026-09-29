/**
 * Inside a body a comment explains the statement under it, so it stays one `//`
 * line however long: a block or a wrapped run of `//` lines reads as a doc
 * comment for a declaration that is not there. Class members and module-level
 * declarations are out of scope and keep the block form.
 */

const MESSAGE = 'Comments inside a body are one // line'

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const SCOPE_STOP_TYPES = new Set(['Program', 'ClassBody', 'StaticBlock'])
const JSX_COMMENT_TYPES = new Set(['JSXEmptyExpression', 'JSXExpressionContainer'])

/**
 * True when the comment sits anywhere inside a function, method, or arrow body,
 * including inside JSX or an object literal nested in that body.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Comment} comment
 * @returns {boolean}
 */
function isInsideFunctionBody(sourceCode, comment) {
  let node = sourceCode.getNodeByRangeIndex(comment.range[0])

  while (node) {
    if (SCOPE_STOP_TYPES.has(node.type)) {
      return false
    }

    if (node.type === 'BlockStatement' && node.parent && FUNCTION_TYPES.has(node.parent.type)) {
      return true
    }

    node = node.parent
  }

  return false
}

/**
 * True when nothing but whitespace precedes the comment on its first line and
 * nothing follows it on its last: only then can the comment be rewritten without
 * commenting out code.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Comment} comment
 * @returns {boolean}
 */
function isOwnLine(sourceCode, comment) {
  const lineStart = sourceCode.getIndexFromLoc({ line: comment.loc.start.line, column: 0 })
  const before = sourceCode.text.slice(lineStart, comment.range[0])
  const after = sourceCode.lines[comment.loc.end.line - 1].slice(comment.loc.end.column)

  return before.trim() === '' && after.trim() === ''
}

/**
 * The comment's prose with the block markers, the per-line ` * ` gutter, and
 * repeated whitespace removed.
 *
 * @param {string} value
 * @returns {string}
 */
function flatten(value) {
  return value
    .split('\n')
    .map((line) => line.replace(/^\s*\*+\s?/, '').trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * True for a marker or a tooling directive, neither of which is prose that may be
 * joined with the line next to it.
 *
 * @param {import('estree').Comment} comment
 * @returns {boolean}
 */
function isProtectedLine(comment) {
  return /^\s*(MARK:|eslint-|@ts-)/.test(comment.value)
}

/**
 * Reports every in-body block comment that is not already a single `// ` line.
 *
 * @param {import('eslint').Rule.RuleContext} context
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Comment[]} inBody
 */
function reportBlockComments(context, sourceCode, inBody) {
  for (const comment of inBody) {
    if (comment.type !== 'Block') {
      continue
    }

    const innermost = sourceCode.getNodeByRangeIndex(comment.range[0])
    const text = flatten(comment.value)
    const fixable = !JSX_COMMENT_TYPES.has(innermost?.type) && isOwnLine(sourceCode, comment) && text !== ''

    context.report({
      loc: comment.loc,
      messageId: 'notSingleLine',
      fix: fixable ? (fixer) => fixer.replaceTextRange(comment.range, `// ${text}`) : undefined,
    })
  }
}

/**
 * `inBody`'s own-line `//` comments, grouped into runs of immediately
 * consecutive lines; a protected line or a gap starts a new run.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Comment[]} inBody
 * @returns {import('estree').Comment[][]}
 */
function groupLineCommentRuns(sourceCode, inBody) {
  const runs = []
  let current = null

  for (const comment of inBody) {
    if (comment.type !== 'Line' || isProtectedLine(comment) || !isOwnLine(sourceCode, comment)) {
      current = null
      continue
    }

    if (current && comment.loc.start.line === current.at(-1).loc.end.line + 1) {
      current.push(comment)
      continue
    }

    current = [comment]
    runs.push(current)
  }

  return runs
}

/**
 * Reports every run of two or more consecutive `//` lines as one violation
 * spanning the run, fixed by joining the lines into one comment.
 *
 * @param {import('eslint').Rule.RuleContext} context
 * @param {import('estree').Comment[][]} runs
 */
function reportLineCommentRuns(context, runs) {
  for (const run of runs) {
    if (run.length < 2) {
      continue
    }

    const text = run.map((comment) => comment.value.trim()).join(' ').replace(/\s+/g, ' ')

    context.report({
      loc: { start: run[0].loc.start, end: run.at(-1).loc.end },
      messageId: 'notSingleLine',
      fix: (fixer) => fixer.replaceTextRange([run[0].range[0], run.at(-1).range[1]], `// ${text}`),
    })
  }
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'layout',
    docs: { description: 'Require every comment inside a function body to be one // line' },
    fixable: 'whitespace',
    schema: [],
    messages: { notSingleLine: MESSAGE },
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      'Program:exit': () => {
        const inBody = sourceCode.getAllComments().filter((comment) => isInsideFunctionBody(sourceCode, comment))

        reportBlockComments(context, sourceCode, inBody)
        reportLineCommentRuns(context, groupLineCommentRuns(sourceCode, inBody))
      },
    }
  },
}

export default rule
