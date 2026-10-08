// MARK: - Title sizing

const TITLE_STEPS: ReadonlyArray<{ maxLength: number; fontSize: number }> = [
  { maxLength: 32, fontSize: 72 },
  { maxLength: 56, fontSize: 60 },
  { maxLength: 90, fontSize: 52 },
]
const TITLE_MIN_FONT_SIZE = 46

/** Steps the title size down by character count so three lines always fit the card. */
export function titleFontSize(title: string): number {
  const step = TITLE_STEPS.find(({ maxLength }) => title.length <= maxLength)

  return step === undefined ? TITLE_MIN_FONT_SIZE : step.fontSize
}

// MARK: - Description sizing

export const DESCRIPTION_MAX_WIDTH = 1072
export const DESCRIPTION_MAX_LINES = 3
const DESCRIPTION_FONT_SIZES = [30, 28, 26, 24] as const
const DESCRIPTION_PREFERRED_LINES = 2
const AVERAGE_CHAR_WIDTH_EM = 0.54

/** Estimated wrapped line count for body text; a conservative average glyph width stands in for real metrics. */
export function estimateLineCount(text: string, fontSize: number, maxWidth: number = DESCRIPTION_MAX_WIDTH): number {
  const charsPerLine = Math.floor(maxWidth / (fontSize * AVERAGE_CHAR_WIDTH_EM))

  return Math.max(1, Math.ceil(text.length / charsPerLine))
}

/** Largest size that wraps to two lines; else the largest that stays within three; else the smallest. */
export function descriptionFontSize(description: string): number {
  const fits = (maxLines: number) => DESCRIPTION_FONT_SIZES.find((size) => estimateLineCount(description, size) <= maxLines)

  return fits(DESCRIPTION_PREFERRED_LINES) ?? fits(DESCRIPTION_MAX_LINES) ?? DESCRIPTION_FONT_SIZES[DESCRIPTION_FONT_SIZES.length - 1]!
}
