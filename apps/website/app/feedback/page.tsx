import type { Metadata } from 'next'
import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'
import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { FeedbackForm } from '@/components/feedback/feedback-form'
import { GITHUB_URL } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Feedback',
  description:
 'Report a bug, ask a question, or send feedback on Kizuna Sync, read by the people building it.',
}

export default function FeedbackPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" className="site-container max-w-2xl pt-28 pb-20">
        <RevealOnScroll>
          <p className="text-site-accent font-mono text-xs tracking-wide uppercase">Feedback</p>
          <h1 className="font-display mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Tell us what&apos;s broken, missing, or working.
          </h1>
          <p className="text-site-muted mt-4 leading-relaxed">
            Bug reports, questions, and general feedback all go to the same place and are read by
            the people building Kizuna. Prefer GitHub? File it as an{' '}
            <a
              href={`${GITHUB_URL}/issues`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-site-accent hover:underline"
            >
              issue
            </a>{' '}
 instead; either way it reaches the same place.
          </p>
        </RevealOnScroll>
        <FeedbackForm />
      </main>
      <SiteFooter />
    </>
  )
}
