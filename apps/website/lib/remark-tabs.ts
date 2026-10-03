/**
 * Turns a `:::tabs` container directive into a <frameworktabs> element that
 * carries its labeled code panels as JSON, so DocMarkdown can Shiki-highlight
 * each panel server-side and hand them to the client tab switcher. Authoring:
 *
 *   :::tabs
 *   ```tsx tab=React
 *   …react code…
 *   ```
 *   ```vue tab=Vue
 *   …vue code…
 *   ```
 *   :::
 *
 * Each inner fence's `tab=<Label>` meta names its tab (`tab="Expo/React Native"` when the label contains spaces); the language drives the
 * highlight. An optional `group` attribute picks which persistence dimension
 * the tabs belong to, such as `:::tabs{group=pm}` for package-manager tabs,
 * and defaults to `framework` when omitted. Runs AFTER remark-directive (which
 * parses the `:::` container and its `{...}` attributes).
 */

// MARK: - remark-tabs

interface IMdNode {
  type: string
  name?: string
  lang?: string | null
  meta?: string | null
  value?: string
  attributes?: Record<string, string | null | undefined> | null
  children?: IMdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

export interface ITabPanel {
  label: string
  lang: string
  code: string
}

function tabLabelFromMeta(meta: string | null | undefined, fallback: string): string {
  if (meta == null || meta.length === 0) {
    return fallback
  }
  const quoted = /tab=(["'])(.*?)\1/.exec(meta)

  if (quoted?.[2] !== undefined) {
    return quoted[2]
  }
  return /tab=(\S+)/.exec(meta)?.[1] ?? fallback
}

export function remarkTabs() {
  return (tree: unknown): void => {
    const walk = (node: IMdNode): void => {
      if (node.type === 'containerDirective' && node.name === 'tabs') {
        const panels: ITabPanel[] = (node.children ?? [])
          .filter((child) => child.type === 'code')
          .map((child) => ({
            label: tabLabelFromMeta(child.meta, child.lang ?? 'Code'),
            lang: child.lang ?? 'ts',
            code: child.value ?? '',
          }))
        const groupId = node.attributes?.group ?? 'framework'

        node.data = {
          hName: 'frameworktabs',
          hProperties: { panels: JSON.stringify(panels), groupId },
        }
        node.children = []

        return
      }
      for (const child of node.children ?? []) {
        walk(child)
      }
    }
    walk(tree as IMdNode)
  }
}
