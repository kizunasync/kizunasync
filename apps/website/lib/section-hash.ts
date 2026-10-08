/**
 * Scroll-spy helpers for the page hash. The current block is the last
 * `section[id]` whose top has crossed the read line; the bare section (the
 * home hero by default) maps to a bare path so the URL stays clean until you
 * leave the fold.
 */
export const HOME_HASH_READ_LINE = 80
const DEFAULT_BARE_SECTION_ID = 'home'

/** Scroll positions are whole pixels while section offsets are fractional, so a section scrolled to the read line can stop just below it. */
const READ_LINE_TOLERANCE = 1

export function stickyReadLine(
  navTop: number | null,
  navBottom: number | null,
  headerOffset: number = HOME_HASH_READ_LINE,
): number {
  if (navTop !== null && navBottom !== null && navTop <= headerOffset + READ_LINE_TOLERANCE && navBottom > headerOffset) {
    return navBottom
  }
  return headerOffset
}

export function activeSectionId(
  sections: readonly { id: string; top: number }[],
  readLine: number,
): string | null {
  if (sections.length === 0) {
    return null
  }
  let activeId = sections[0]?.id ?? null

  for (const section of sections) {
    if (section.top <= readLine + READ_LINE_TOLERANCE) {
      activeId = section.id
    }
  }
  return activeId
}

export function hashForSection(id: string, bareSectionId: string = DEFAULT_BARE_SECTION_ID): string {
  if (id === bareSectionId) {
    return ''
  }
  return `#${id}`
}

/** True when `href` points at a fragment of the page at `currentHref` (same origin and path), so following it only scrolls. */
export function isSamePageHashLink(href: string, currentHref: string): boolean {
  if (!URL.canParse(href, currentHref)) {
    return false
  }
  const target = new URL(href, currentHref)
  const current = new URL(currentHref)

  return target.hash !== '' && target.origin === current.origin && target.pathname === current.pathname
}
