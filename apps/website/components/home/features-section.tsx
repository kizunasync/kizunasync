import { FeatureSpotlight } from '@/components/feature-spotlight'
import { FEATURES } from '@/components/home/features.data'
import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { Section } from '@/components/section'

export function FeaturesSection() {
  return (
    <Section id="features" bordered={false}>
      <RevealOnScroll>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-site-accent font-mono text-xs tracking-wide uppercase">
            The engine
          </p>
        </div>
        <h2 className="font-display mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
          Implemented surfaces, with their limits named in place.
        </h2>
        <p className="text-site-muted mt-2 leading-relaxed sm:text-lg">
          The current Alpha covers local writes, pull and push, schema gates, retained
          deletes, attachments, framework bindings, provisioning, and inspection. It does
          not turn unit coverage into crash, scale, device, or uptime promises.
        </p>
      </RevealOnScroll>
      <RevealOnScroll className="mt-10">
        <FeatureSpotlight features={FEATURES} />
      </RevealOnScroll>
    </Section>
  )
}
