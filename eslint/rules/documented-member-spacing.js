/**
 * A documented member stands apart from its neighbors: one blank line above
 * its doc block and one blank line after the member itself, so the doc block
 * reads as its own paragraph instead of blending into a run of one-liners.
 * Undocumented members carry no such rule and may keep touching each other.
 */

const MEMBER_KEY = {
  TSInterfaceBody: 'body',
  TSTypeLiteral: 'members',
  ClassBody: 'body',
}

/**
 * The last token or comment that still sits on `node`'s end line: a trailing
 * `,`/`;` punctuator or a trailing `// note` stays with the member it closes.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Node} node
 * @returns {import('estree').Token | import('estree').Comment}
 */
function lastTokenOnLine(sourceCode, node) {
  let last = sourceCode.getLastToken(node)
  let next = sourceCode.getTokenAfter(last, { includeComments: true })

  while (next && next.loc.start.line === last.loc.end.line) {
    last = next
    next = sourceCode.getTokenAfter(last, { includeComments: true })
  }

  return last
}

/**
 * The member's own doc block: the last `/** … *\/` comment before it, only
 * when that comment falls after `afterIndex` (the previous member's end, or
 * the body's opening `{` for the first member) so a comment left trailing on
 * the previous member's line is never mistaken for this member's doc block.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Node} member
 * @param {number} afterIndex
 * @returns {import('estree').Comment | null}
 */
function docCommentFor(sourceCode, member, afterIndex) {
  const blocks = sourceCode
    .getCommentsBefore(member)
    .filter((comment) => comment.type === 'Block' && comment.value.startsWith('*'))
  const doc = blocks.at(-1)

  return doc && doc.range[0] >= afterIndex ? doc : null
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'layout',
    docs: { description: 'Require one blank line around a documented interface, type literal, or class member' },
    fixable: 'whitespace',
    schema: [],
    messages: {
      before: 'A documented member is preceded by one blank line (unless it is the first member).',
      after: 'A documented member is followed by one blank line (unless it is the last member).',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode

    // @param {import('estree').Node} node
    const check = (node) => {
      const members = node[MEMBER_KEY[node.type]]
      let afterIndex = sourceCode.getFirstToken(node).range[1]

      members.forEach((member, i) => {
        const doc = docCommentFor(sourceCode, member, afterIndex)

        if (doc && i > 0) {
          const prevEnd = lastTokenOnLine(sourceCode, members[i - 1])

          if (doc.loc.start.line < prevEnd.loc.end.line + 2) {
            context.report({
              loc: doc.loc,
              messageId: 'before',
              fix: (fixer) => fixer.insertTextAfter(prevEnd, '\n'),
            })
          }
        }

        if (doc && i < members.length - 1) {
          const memberEnd = lastTokenOnLine(sourceCode, member)
          const nextStart = sourceCode.getTokenAfter(memberEnd, { includeComments: true })

          if (nextStart.loc.start.line < memberEnd.loc.end.line + 2) {
            context.report({
              loc: member.loc,
              messageId: 'after',
              fix: (fixer) => fixer.insertTextAfter(memberEnd, '\n'),
            })
          }
        }

        afterIndex = member.range[1]
      })
    }

    return {
      TSInterfaceBody: check,
      TSTypeLiteral: check,
      ClassBody: check,
    }
  },
}

export default rule
