// MARK: - BrandMark

export function BrandMark({ suffix }: { suffix?: string }) {
  return (
    <span className="flex items-baseline gap-1.5 font-semibold tracking-tight">
      <span className="text-site-accent text-lg leading-none" aria-hidden="true">
        絆
      </span>
      <span>Kizuna Sync</span>
      {suffix !== undefined ? <span className="text-site-muted">{suffix}</span> : null}
    </span>
  )
}
