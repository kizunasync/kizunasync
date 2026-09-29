import { Alert } from '@heroui/react/alert'
import { Card } from '@heroui/react/card'

// MARK: - Components

export function StackDownAlert({ detail }: { detail: string }) {
  return (
    <Alert status="danger" className="border-site-border/80 mt-8 border">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title className="font-medium">Local Supabase is not running</Alert.Title>
        <Alert.Description className="text-site-muted flex flex-col gap-2 text-sm leading-relaxed">
          <span>
            Start it with <code className="text-site-text font-mono">bun run db:start</code> or{' '}
            <code className="text-site-text font-mono">bun run dev</code> from the repository root.
            The view refreshes on its own once it is up.
          </span>
          <code className="border-site-border/60 bg-site-background/40 text-site-muted rounded-md border px-2 py-1 font-mono text-xs">
            {detail}
          </code>
        </Alert.Description>
      </Alert.Content>
    </Alert>
  )
}

export function MissingKeyCard() {
  return (
    <Card className="border-site-border/80 bg-site-surface/70 mt-8 border backdrop-blur-sm">
      <Card.Header className="border-site-border/60 border-b px-5 py-3.5">
        <Card.Title className="font-medium">No service-role key configured</Card.Title>
      </Card.Header>
      <Card.Content className="text-site-muted px-5 py-4 text-sm leading-relaxed">
        Copy the repo-root{' '}
        <code className="text-site-text font-mono text-[0.8rem]">.env.example</code> to{' '}
        <code className="text-site-text font-mono text-[0.8rem]">.env</code> and fill{' '}
        <code className="text-site-text font-mono text-[0.8rem]">
          INSPECTOR_SUPABASE_SERVICE_ROLE_KEY
        </code>
        , then reload. The example contains only the public local-development credentials issued by{' '}
        <code className="text-site-text font-mono text-[0.8rem]">supabase start</code>.
      </Card.Content>
    </Card>
  )
}
