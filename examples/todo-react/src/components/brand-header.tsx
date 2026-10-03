import { t } from '../i18n'

// MARK: - Brand header

/**
 * Two distinct brand markups, consolidated here rather than forced into one:
 * TopNavBrand (glyph + name only) rides the top bar (TopNav and the boot-time
 * Shell); Brand (glyph + name + a per-screen sub-label) is the screen header
 * used by the Cache/Settings tabs and the boot Shell's body.
 */
export function TopNavBrand() {
  return (
    <span className="topnav-brand">
      <span className="topnav-brand-glyph" aria-hidden="true">
        絆
      </span>
      <span className="topnav-brand-text">Kizuna Sync</span>
    </span>
  )
}

export function Brand({ sub }: { sub: string }) {
  return (
    <header className="screen-brand">
      <span className="screen-brand-glyph" aria-hidden="true">
        絆
      </span>
      <span className="screen-brand-text">{t('brand.name')}</span>
      <span className="screen-brand-sub">{sub}</span>
    </header>
  )
}
