import type { ReactNode } from 'react'
import { Card } from '@heroui/react/card'

// MARK: - Component

export function InspectorPanel({
  id,
  title,
  meta,
  children,
}: {
  id?: string
  title: string
  meta?: string
  children: ReactNode
}) {
  return (
    <Card
      id={id}
      className="border-site-border/80 bg-site-surface/70 shadow-site-background/20 overflow-hidden border shadow-lg backdrop-blur-sm"
    >
      <Card.Header className="border-site-border/60 flex items-center gap-2 border-b px-4 py-2">
        <Card.Title className="text-site-text/90 font-mono text-[0.8rem] font-medium tracking-tight">
          {title}
        </Card.Title>
        {meta !== undefined ? (
          <span className="text-site-muted min-w-0 truncate font-mono text-[0.68rem] tracking-wide tabular-nums">
            · {meta}
          </span>
        ) : null}
      </Card.Header>
      <Card.Content className="px-1 py-1">{children}</Card.Content>
    </Card>
  )
}
