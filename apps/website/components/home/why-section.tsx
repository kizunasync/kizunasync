import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { Section } from '@/components/section'

export function WhySection() {
  return (
    <Section
      id="why"
      bordered={false}
      containerClassName="max-w-3xl pb-0 sm:pb-0"
    >
      <RevealOnScroll>
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
          Why zero data plane
        </h2>
      </RevealOnScroll>
      <RevealOnScroll className="text-site-muted mt-6 space-y-5 leading-relaxed">
        <p>
          Kizuna places no Kizuna-operated service between a client and its Supabase
          project. The trade-off is explicit: you keep the SQL, credentials, quotas,
          upgrades, retention, and operational evidence in your own environment. This
          architecture avoids adding a Kizuna-operated hop; it does not promise zero downtime.
        </p>
        <blockquote className="border-site-accent text-site-text border-l-2 pl-5 italic">
          &quot;In local-first software, the availability of another computer should never
          prevent you from working.&quot;
          <cite className="text-site-faint mt-2 block text-sm not-italic">
            Kleppmann, Wiggins, van Hardenberg &amp; McGranaghan, &quot;Local-first software&quot;
            (2019)
          </cite>
        </blockquote>
        <p>
          Kizuna's protocol is scoped on purpose: it draws on
          Bayou's tentative writes and server arbitration (1995), session guarantees (1994),
          and causal+ consistency to checkpoints (COPS, 2011). The default is column-LWW by accepted
          server arrival; an optional mode uses clamped HLC ordering. Both remain subject to
          RLS, grants, constraints, preconditions, tombstone retention, and successful
          checkpoints.
        </p>
        <p className="text-site-faint text-sm">
          Sources:{' '}
          <a
            href="https://www.inkandswitch.com/local-first/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-site-accent hover:underline"
          >
            Local-first software
          </a>
          {' · '}
          <a
            href="https://dl.acm.org/doi/10.1145/224056.224070"
            target="_blank"
            rel="noopener noreferrer"
            className="text-site-accent hover:underline"
          >
            Bayou (SOSP 1995)
          </a>
          {' · '}
          <a
            href="https://www.cs.cmu.edu/~dga/papers/cops-sosp2011.pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="text-site-accent hover:underline"
          >
            COPS (SOSP 2011)
          </a>
        </p>
      </RevealOnScroll>
    </Section>
  )
}
