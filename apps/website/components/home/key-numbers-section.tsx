import { StatCounter } from '@/components/motion/stat-counter'
import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { corpusCaseCount } from '@/lib/corpus'

export function KeyNumbersSection() {
  return (
    <section aria-label="Key numbers" className="border-site-border/60 border-y">
      <RevealOnScroll
        staggerChildren
        className="site-container grid grid-cols-2 gap-x-4 gap-y-6 py-8 text-center sm:grid-cols-4 sm:gap-6"
      >
        <StatCounter value={0} label="extra Kizuna data-plane services" />
        <StatCounter value={5} label="authenticated public RPCs" />
        <StatCounter value={5} label="in-repository example apps" />
        <StatCounter value={corpusCaseCount()} label="protocol corpus cases" />
      </RevealOnScroll>
    </section>
  )
}
