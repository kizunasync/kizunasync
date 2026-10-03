import type { ButtonRootProps } from 'heroui-native'

/**
 * Android counterpart of `press-feedback.ts`: a touch on Material spreads a
 * ripple from where the finger landed, which is the affordance users read as
 * "that registered" on this platform.
 */
export const PRESS_FEEDBACK: ButtonRootProps['feedbackVariant'] = 'scale-ripple'
