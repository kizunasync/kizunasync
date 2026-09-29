/**
 * An import or re-export is one statement and reads as one line, however many
 * specifiers it carries: the 120-column guide does not apply to it. Wrapping the
 * brace block turns a sorted list into a diff that moves whenever a name is
 * added, and hides the module path below the fold.
 */

const MESSAGE = 'Import and re-export statements are one line'

/**
 * The statement rewritten on one line: whitespace collapsed, one space inside the
 * braces, no trailing comma, and the module path copied verbatim so its quotes
 * survive.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Node} node
 * @returns {string}
 */
function onOneLine(sourceCode, node) {
  const head = sourceCode.text
    .slice(node.range[0], node.source.range[0])
    .replace(/\s+/g, ' ')
    .replace(/\{\s*/, '{ ')
    .replace(/,?\s*\}/, ' }')
    .replace(/\{ \}/, '{}')
  const tail = sourceCode.text.slice(node.source.range[1], node.range[1]).replace(/\s+/g, ' ')

  return `${head}${sourceCode.getText(node.source)}${tail}`
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'layout',
    docs: { description: 'Require every import and re-export statement to sit on one line' },
    fixable: 'code',
    schema: [],
    messages: { multiLine: MESSAGE },
  },
  create(context) {
    const sourceCode = context.sourceCode

    // @param {import('estree').Node} node
    const check = (node) => {
      if (!node.source || node.loc.start.line === node.loc.end.line) {
        return
      }

      const hasComments = sourceCode.getCommentsInside(node).length > 0

      context.report({
        node,
        messageId: 'multiLine',
        fix: hasComments ? undefined : (fixer) => fixer.replaceTextRange(node.range, onOneLine(sourceCode, node)),
      })
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    }
  },
}

export default rule
