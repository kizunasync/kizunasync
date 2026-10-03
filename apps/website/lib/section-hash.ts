/**
 * Scroll-spy helpers for the landing page hash. The current block is the last
 * `section[id]` whose top has crossed the read line; the hero (`home`) maps to
 * a bare path so the marketing URL stays clean until you leave the fold.
 */
export const HOME_HASH_READ_LINE = 80
const HOME_HASH_HERO_ID = 'home'

export function stickyReadLine(
  navTop: number | null,
  navBottom: number | null,
  headerOffset: number = HOME_HASH_READ_LINE,
): number {
  if (navTop !== null && navBottom !== null && navTop <= headerOffset + 1 && navBottom > headerOffset) {
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
    if (section.top <= readLine) {
      activeId = section.id
    }
  }
  return activeId
}

export function hashForSection(id: string, heroId: string = HOME_HASH_HERO_ID): string {
  if (id === heroId) {
    return ''
  }
  return `#${id}`
}
