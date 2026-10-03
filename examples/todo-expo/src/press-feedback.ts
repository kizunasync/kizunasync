import type { ButtonRootProps } from 'heroui-native'

/**
 * How a heroui button answers a press. iOS has no ripple: a highlight plus the
 * scale is the platform's own vocabulary, so the default path uses that and
 * `press-feedback.android.ts` swaps in Material's ripple.
 */
export const PRESS_FEEDBACK: ButtonRootProps['feedbackVariant'] = 'scale-highlight'
