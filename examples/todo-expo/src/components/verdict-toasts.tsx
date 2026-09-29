import { useEffect } from 'react'
import { Toast, useToast } from 'heroui-native'
import { EVerdictLevel, subscribeVerdictToasts, type IKizunaSync, type TVerdictLevel } from '@kizunasync/core'

/**
 * Server verdicts as non-blocking toasts.
 *
 * Alert.alert steals focus and hides the board behind a modal. This demo
 * needs writes to reconcile while the board stays visible, so a verdict
 * renders as a toast. Wording is still the shared verdictToMessage output;
 * every platform says the same thing, only the presentation is local.
 * Confirmations and the Cache tab's tap-to-explain keep Alert.alert, because
 * those must interrupt.
 *
 * Renders nothing: useToast has to run inside HeroUINativeProvider, and the
 * root layout is the component that mounts that provider.
 */
// MARK: - Verdict toasts

/**
 * heroui's own default is 4s; pinned here so the contract survives a library
 * default change.
 */
const TOAST_DURATION_MS = 4000

const LEVEL_VARIANT: Record<TVerdictLevel, 'danger' | 'warning'> = {
  [EVerdictLevel.error]: 'danger',
  [EVerdictLevel.warning]: 'warning',
}

export function VerdictToasts({ client }: { client: IKizunaSync }) {
  const { toast } = useToast()

  useEffect(
    () =>
      subscribeVerdictToasts(client, (message) => {
        toast.show({
          duration: TOAST_DURATION_MS,
          component: (props) => (
            <Toast variant={LEVEL_VARIANT[message.level]} placement="top" {...props}>
              <Toast.Title>{message.title}</Toast.Title>
              <Toast.Description>{message.message}</Toast.Description>
              <Toast.Close />
            </Toast>
          ),
        })
      }),
    [client, toast],
  )

  return null
}
