/**
 * Maps a section's viewport box onto 0 → 1 reading progress relative to a
 * horizontal "read line" (the sticky journey nav's bottom edge). 0 while the
 * section still sits fully below that line; 1 once its bottom has crossed it.
 */
export function sectionScrollProgress(top: number, height: number, readLine: number): number {
  if (height <= 0) {
    return 0
  }
  const raw = (readLine - top) / height

  if (raw <= 0) {
    return 0
  }
  if (raw >= 1) {
    return 1
  }
  return Math.round(raw * 1000) / 1000
}

export function journeyBarProgress(progresses: readonly number[]): number {
  if (progresses.length === 0) {
    return 0
  }
  const total = progresses.reduce((sum, value) => sum + value, 0)

  return Math.round((total / progresses.length) * 1000) / 1000
}

export function activeJourneyIndex(progresses: readonly number[]): number {
  let activeIndex = 0

  for (let index = 0; index < progresses.length; index += 1) {
    const progress = progresses[index]

    if (progress === undefined) {
      break
    }
    if (progress > 0) {
      activeIndex = index
    }
    if (progress < 1) {
      break
    }
  }
  return activeIndex
}
