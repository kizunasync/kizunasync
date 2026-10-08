import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkDirective from 'remark-directive'
import { visit } from 'unist-util-visit'
import { headingIds, type IHeadingId } from './heading-ids'
import { remarkTabs } from './remark-tabs'

// MARK: - Markdown sections

export interface IMarkdownSection {
  heading: string
  id: string
  bodyMarkdown: string
  bodyText: string

  /** Text of the nearest preceding heading shallower than the requested depth; absent when there is none. */
  parentHeading?: string
}

/** H2s that close a reader page; they and everything after them never become sections. */
const CLOSING_HEADINGS: ReadonlySet<string> = new Set(['Related pages', 'Related reference', 'Next steps'])

/** Inline containers whose children run together; every other parent separates its children with a space. */
const PHRASING_PARENTS: ReadonlySet<string> = new Set(['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'linkReference', 'tableCell'])

type TMarkdownRoot = ReturnType<typeof parseMarkdown>
type TMarkdownNode = TMarkdownRoot['children'][number]
type TMarkdownHeading = Extract<TMarkdownNode, { type: 'heading' }>

interface IOpenSection {
  heading: string
  id: string
  parentHeading: string | undefined
  body: TMarkdownNode[]
}

/**
 * Splits `markdown` (front matter already stripped) at its top-level headings of `depth`. A body runs to the next
 * heading of the same or a higher level, so an H2 body keeps its H3s. Ids come from `headingIds()` over the whole
 * document, so they equal the anchors DocMarkdown renders, deduplication suffixes included.
 */
export function markdownSections(markdown: string, depth: 2 | 3): IMarkdownSection[] {
  const tree = parseMarkdown(markdown)
  const rendered = mapRenderedHeadings(tree, headingIds(markdown))
  const sections: IOpenSection[] = []
  let open: IOpenSection | null = null
  let parentHeading: string | undefined

  for (const node of tree.children) {
    const heading = node.type === 'heading' ? rendered.get(node) : undefined

    if (heading === undefined || heading.depth > depth) {
      open?.body.push(node)
      continue
    }
    if (heading.depth === 2 && CLOSING_HEADINGS.has(heading.text)) {
      break
    }
    if (heading.depth < depth) {
      open = null
      parentHeading = heading.text
      continue
    }
    open = startSection(heading, parentHeading)
    sections.push(open)
  }
  return sections.map((section) => closeSection(markdown, section))
}

// MARK: - Helpers

function closeSection(markdown: string, section: IOpenSection): IMarkdownSection {
  return {
    heading: section.heading,
    id: section.id,
    ...(section.parentHeading === undefined ? {} : { parentHeading: section.parentHeading }),
    bodyMarkdown: sliceSource(markdown, section.body),
    bodyText: section.body.map(collectText).join(' ').replace(/\s+/g, ' ').trim(),
  }
}

function startSection(heading: IHeadingId, parentHeading: string | undefined): IOpenSection {
  return { heading: heading.text, id: heading.id, parentHeading, body: [] }
}

/** Same syntax extensions and tabs transform as DocMarkdown, so headings line up one to one with `headingIds()`. */
function parseMarkdown(markdown: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).parse(markdown)

  remarkTabs()(tree)

  return tree
}

/** Pairs each heading node with its `headingIds()` entry; both walk the document in the same order. */
function mapRenderedHeadings(tree: TMarkdownRoot, ids: IHeadingId[]): Map<TMarkdownHeading, IHeadingId> {
  const rendered = new Map<TMarkdownHeading, IHeadingId>()
  let index = 0

  visit(tree, 'heading', (node) => {
    const heading = ids[index]

    index += 1

    if (heading !== undefined) {
      rendered.set(node, heading)
    }
  })

  return rendered
}

function sliceSource(markdown: string, nodes: TMarkdownNode[]): string {
  const start = nodes[0]?.position?.start.offset
  const end = nodes.at(-1)?.position?.end.offset

  return start === undefined || end === undefined ? '' : markdown.slice(start, end).trim()
}

/** Plain text of a node: text and inline code (hard breaks become spaces), so link text stays while URLs and image alts drop out. */
function collectText(node: TMarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value
  }
  if (node.type === 'break') {
    return ' '
  }
  if (!('children' in node)) {
    return ''
  }
  const separator = PHRASING_PARENTS.has(node.type) ? '' : ' '

  return node.children.map(collectText).join(separator)
}
