import { CONFLICT_WINNER } from '@/lib/conflict'

/** Static explainer: how column-LWW resolves the demo's conflict scenario, plus the docs link. */
export function DemoFooter() {
  return (
    <footer className="border-t border-site-border px-4 pt-4 pb-8 text-xs leading-relaxed text-site-muted sm:px-6">
      <p className="mb-2">
        Conflicts merge per column in server arrival order, so the write that reaches the server second wins that
        column: pane {CONFLICT_WINNER} in this demo. Row authority stays with Postgres: RLS refuses what it refuses,
        and the client reverts.
      </p>
      <p className="mb-0">
        <a
          className="text-site-accent underline underline-offset-2"
          href="https://kizunasync.com/docs"
          target="_blank"
          rel="noopener noreferrer"
        >
          kizunasync.com/docs
        </a>
      </p>
    </footer>
  )
}
