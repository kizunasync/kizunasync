import { CompareHeadToHeadCard } from '@/components/compare/compare-head-to-head-card'
import { COMPARISONS } from '@/components/compare/compare-head-to-heads.data'

export function CompareHeadToHeads() {
  return (
    <div className="mt-16 space-y-8">
      {COMPARISONS.map((entry) => (
        <CompareHeadToHeadCard key={entry.id} entry={entry} />
      ))}
    </div>
  )
}
