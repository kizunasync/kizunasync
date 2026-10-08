export interface IPlaceTipParams {
  trigger: { top: number; left: number; width: number; height: number }
  panel: { width: number; height: number }
  viewport: { width: number; height: number }
  gap: number
}

const EDGE_MARGIN = 8

/** Viewport-relative placement for a toggletip panel: below the trigger, above when it would overflow, clamped horizontally. */
export function placeTip({ trigger, panel, viewport, gap }: IPlaceTipParams): { top: number; left: number } {
  const below = trigger.top + trigger.height + gap
  const top = below + panel.height > viewport.height - EDGE_MARGIN ? trigger.top - gap - panel.height : below
  const centered = trigger.left + trigger.width / 2 - panel.width / 2
  const left = Math.min(Math.max(centered, EDGE_MARGIN), viewport.width - EDGE_MARGIN - panel.width)

  return { top, left }
}
