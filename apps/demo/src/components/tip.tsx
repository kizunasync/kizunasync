import { cloneElement, type ReactElement } from 'react'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@heroui/react'

// MARK: - Tip

/**
 * `render` hands back the trigger's DOM props (ref, role, tabIndex, aria-describedby,
 * the hover/focus/keyboard handlers) without ever mounting a wrapper element, so
 * cloning them onto the existing control keeps its own markup, styling, and
 * aria-label untouched: the tooltip is purely an added layer. `className` is
 * dropped from that merge: HeroUI's trigger slot only contributes `inline-block`
 * and a transition, and letting it compete with the control's own `flex`/`grid`
 * utility at equal Tailwind specificity would be a coin flip on source order.
 * `children` is dropped too: the slot's (empty) children key would otherwise
 * override the control's real content in cloneElement, blanking every button.
 */
export function Tip({ text, children }: { text: string; children: ReactElement }) {
  return (
    <TooltipRoot>
      <TooltipTrigger
        render={({ className: _slotClassName, children: _slotChildren, ...triggerProps }) =>
          cloneElement(children, triggerProps)
        }
      />
      <TooltipContent showArrow>{text}</TooltipContent>
    </TooltipRoot>
  )
}
