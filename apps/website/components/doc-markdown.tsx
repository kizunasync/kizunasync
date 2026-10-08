import Link from 'next/link'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkDirective from 'remark-directive'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import { resolveDocHref } from '@/lib/docs-registry'
import { MermaidDiagram } from '@/components/mermaid-diagram'
import { FrameworkTabs } from '@/components/framework-tabs'
import { CopyCodeButton } from '@/components/copy-code-button'
import { remarkTabs, type ITabPanel } from '@/lib/remark-tabs'
import { CODE_THEME, getHighlighter, resolveLang } from '@/lib/code-highlight'
import { SITE_URL } from '@/lib/site'

// MARK: - Site links

const SITE_ORIGIN = new URL(SITE_URL).origin

/** Docs link the site by absolute URL so the link also works on GitHub; on the site itself it stays an in-site path. */
function resolveSitePath(href: string): string | null {
  if (!/^https?:/.test(href) || !URL.canParse(href)) {
    return null
  }
  const url = new URL(href)

  return url.origin === SITE_ORIGIN ? `${url.pathname}${url.search}${url.hash}` : null
}

// MARK: - Heading anchors

/**
 * Hover-revealed "#" after every h2/h3 (rehype-slug already gave them ids);
 * styling (opacity, no layout shift) lives in globals.css under .docs-anchor.
 */
const ANCHOR_OPTIONS = {
  behavior: 'append' as const,
  test: ['h2', 'h3'],
  properties: { className: ['docs-anchor'], ariaLabel: 'Link to this section' },
  content: { type: 'text' as const, value: '#' },
}

// MARK: - DocMarkdown

/**
 * Server-rendered markdown for the in-site docs viewer. GFM tables, slugged
 * headings (anchors match lib/docs extractHeadings), repo-relative links
 * rewritten in-site or to GitHub, Shiki syntax highlighting (on-brand
 * site-dark theme) and ```mermaid blocks rendered as diagrams. Styling lives
 * in globals.css (.docs-prose). Async because the Shiki highlighter loads its
 * grammars once before render; the highlight call itself is then synchronous.
 */

/**
 * A ```mermaid block reaches the `pre` override as a single <code
 * className="language-mermaid"> child; we swap the whole <pre> for the diagram
 * (a <div> cannot nest inside <pre>).
 */
type TPreChild = { props?: { className?: string; children?: unknown } }

export async function DocMarkdown({
  content,
  sourceFile,
  variant,
}: {
  content: string
  sourceFile?: string

  /** `card` restyles headings and lists for a card on a marketing page and drops heading ids, which would repeat across cards. */
  variant?: 'card'
}) {
  const highlighter = await getHighlighter()
  const isCard = variant === 'card'

  return (
    <div className={isCard ? 'docs-prose docs-prose-card' : 'docs-prose'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkDirective, remarkTabs]}
        rehypePlugins={isCard ? [] : [rehypeSlug, [rehypeAutolinkHeadings, ANCHOR_OPTIONS]]}
        components={
          {
            // A `:::tabs` block becomes <frameworktabs panels="…json…" groupId="…">; highlight each panel server-side, then hand the labeled HTML to the client tab switcher (custom element key isn't in react-markdown's typed Components, hence the cast). `groupId` namespaces persistence so, say, framework tabs and package-manager tabs never cross-sync.
            frameworktabs: ({ panels, groupId }: { panels?: string; groupId?: string }) => {
              const parsed = JSON.parse(panels ?? '[]') as ITabPanel[]
              const groups = parsed.map((panel) => ({
                label: panel.label,
                code: panel.code,
                html: highlighter.codeToHtml(panel.code, {
                  lang: resolveLang(panel.lang, highlighter),
                  theme: CODE_THEME,
                }),
              }))

              return <FrameworkTabs groups={groups} groupId={groupId} />
            },
            pre: ({ children }) => {
            const child = (Array.isArray(children) ? children[0] : children) as TPreChild
            const className = child?.props?.className ?? ''
            const code = String(child?.props?.children ?? '').replace(/\n$/, '')

            if (className === 'language-mermaid') {
              return <MermaidDiagram chart={code} />
            }
            const requested = /language-(\w+)/.exec(className)?.[1]
            const html = highlighter.codeToHtml(code, {
              lang: resolveLang(requested, highlighter),
              theme: CODE_THEME,
            })

            return (
              <div className="group relative">
                <div className="shiki-block" dangerouslySetInnerHTML={{ __html: html }} />
                <CopyCodeButton code={code} />
              </div>
            )
          },
          a: ({ node: _node, href, children, ...props }) => {
            const resolved = resolveDocHref(href ?? '#', sourceFile)
            const inSite = resolveSitePath(resolved)

            if (inSite !== null) {
              return (
                <Link href={inSite} {...props}>
                  {children}
                </Link>
              )
            }
            const external = resolved.startsWith('http')

            return (
              <a
                href={resolved}
                {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                {...props}
              >
                {children}
              </a>
            )
          },
          } as Components
        }
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
