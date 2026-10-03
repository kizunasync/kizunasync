'use client'

import type { ReactNode } from 'react'
import { Button } from '@heroui/react/button'
import { Modal } from '@heroui/react/modal'

const REPO_URL = 'https://github.com/kizunasync/kizunasync'
const REPO_PATH = 'apps/sync-inspector'

/** One `title` + prose section of the info modal body; every section shares this shape. */
function InfoModalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-site-accent/80 text-[0.7rem] font-semibold uppercase tracking-wider">{title}</h3>
      <p className="text-site-muted">{children}</p>
    </section>
  )
}

/**
 * A pressable 'i' in the header opening a HeroUI Modal that explains what this
 * inspector is, how it stays read-only, and where it lives in the repo.
 */
export function InfoModal() {
  return (
    <Modal>
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label="About the sync inspector"
        className="border-site-border text-site-muted hover:text-site-text hover:border-site-faint size-6 rounded-full border font-serif text-[0.8rem] italic leading-none transition-colors"
      >
        i
      </Button>
      <Modal.Backdrop className="bg-site-background/70 backdrop-blur-sm">
        <Modal.Container size="md" placement="center">
          <Modal.Dialog className="border-site-border bg-site-surface text-site-text shadow-site-background/40 border shadow-2xl">
            <Modal.Header className="border-site-border/60 flex items-center gap-2 border-b px-6 py-4">
              <span className="text-site-accent text-xl leading-none" aria-hidden="true">
                絆
              </span>
              <Modal.Heading className="text-base font-semibold tracking-tight">
                Kizuna Sync Inspector
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-5 px-6 py-5 text-sm leading-relaxed">
              <InfoModalSection title="Purpose">
                A read-only, local-dev window over <em>your own</em> Supabase stack. Keep it open
                while running the example apps to watch <code className="font-mono">todos</code>{' '}
                sync, changelog and tombstone entries arrive, registered{' '}
                <code className="font-mono">_clients</code> appear, and rejected verdicts surface.
              </InfoModalSection>
              <InfoModalSection title="What it does">
                Nine read-only panels: <code className="font-mono">public.todos</code>, a merged
                changelog/tombstone feed, registered <code className="font-mono">_clients</code>,
                rejected <code className="font-mono">_verdicts</code>,{' '}
                <code className="font-mono">_settings</code>, the three{' '}
                <code className="font-mono">cron.job</code> maintenance jobs, retention (the reap
                watermark and tombstones by table), the <code className="font-mono">
                  _conflict_journal
                </code>
                , and confirmed <code className="font-mono">attachments</code>. It only reads: it
                never writes, mutates, or provisions.
              </InfoModalSection>
              <InfoModalSection title="Technologies">
                Next.js with the service-role read kept server-side (never shipped to the
                browser), a Supabase Realtime doorbell for instant live refresh, and HeroUI for
                the interface.
              </InfoModalSection>
              <InfoModalSection title="Repo path">
                <code className="font-mono">{REPO_PATH}</code> in{' '}
                <a
                  className="text-site-accent hover:text-site-accent-bright underline underline-offset-2"
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  kizunasync/kizunasync
                </a>
                .
              </InfoModalSection>
            </Modal.Body>
            <Modal.Footer className="border-site-border/60 flex justify-end border-t px-6 py-4">
              <Button slot="close" variant="secondary" size="sm">
                Close
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
