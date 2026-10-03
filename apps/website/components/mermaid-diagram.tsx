'use client'

import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

// MARK: - Mermaid diagram

/**
 * Renders a ```mermaid fenced block as SVG in the browser. mermaid runs only
 * client-side (it touches the DOM), so this is a client component embedded by
 * the server-rendered DocMarkdown. securityLevel 'strict' disables script/click
 * directives; on a parse error we fall back to the raw source so the page never
 * breaks on a malformed diagram.
 */
let initialized = false

export function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`)

  useEffect(() => {
    if (!initialized) {
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
      initialized = true
    }
    let active = true

    mermaid
      .render(idRef.current, chart)
      .then((result) => {
        if (active) {
          setSvg(result.svg)
        }
      })
      .catch(() => {
        if (active) {
          setSvg(null)
        }
      })

    return () => {
      active = false
    }
  }, [chart])

  if (svg === null) {
    return (
      <pre className="docs-mermaid-fallback">
        <code>{chart}</code>
      </pre>
    )
  }
  return <div className="docs-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
}
