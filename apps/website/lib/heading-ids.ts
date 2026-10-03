import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkDirective from 'remark-directive'
import remarkRehype from 'remark-rehype'
import rehypeSlug from 'rehype-slug'
import { visit } from 'unist-util-visit'
import { toString } from 'hast-util-to-string'
import { remarkTabs } from './remark-tabs'

// MARK: - Heading ids

/** A single heading as rehype-slug ids it; matches DocMarkdown (doc-markdown.tsx) exactly. */
export interface IHeadingId {
  depth: 1 | 2 | 3 | 4 | 5 | 6
  text: string
  id: string
}

const HEADING_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/**
 * Runs the same remark/rehype pipeline as DocMarkdown up through rehype-slug
 * (remark-gfm, remark-directive, remark-tabs, remark-rehype, rehype-slug), so
 * the ids returned here match the ids the renderer assigns to on-page
 * headings exactly. `markdown` is the document body without front matter;
 * callers strip it.
 */
export function headingIds(markdown: string): IHeadingId[] {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkTabs)
    .use(remarkRehype)
    .use(rehypeSlug)
  const tree = processor.runSync(processor.parse(markdown))
  const headings: IHeadingId[] = []

  visit(tree, 'element', (node) => {
    if (!HEADING_TAGS.has(node.tagName)) {
      return
    }
    const id = node.properties.id

    headings.push({
      depth: Number(node.tagName.slice(1)) as IHeadingId['depth'],
      text: toString(node),
      id: typeof id === 'string' ? id : '',
    })
  })

  return headings
}
