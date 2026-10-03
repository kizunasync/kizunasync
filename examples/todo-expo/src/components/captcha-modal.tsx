import { useSyncExternalStore } from 'react'
import { Text } from 'react-native'
import { sharedStyles } from '../shared-styles'
import { t } from '../i18n'
import { captchaGate, TURNSTILE_SITE_KEY } from '../lib/public-demo'
import { AppModal } from './app-modal'
import { TurnstileChallenge } from './turnstile-challenge'

/** The Turnstile check the public demo project requires before it mints a visitor, shown while a sign-in awaits a token. */
export function CaptchaModal() {
  const isPending = useSyncExternalStore(captchaGate.subscribe, captchaGate.isPending, captchaGate.isPending)

  return (
    <AppModal
      visible={isPending}
      title={t('captcha.title')}
      actions={null}
      onDismiss={() => {
        // The sign-in awaits this token, so dismissing would leave the app without an identity.
      }}
    >
      <Text style={sharedStyles.modalBody}>{t('captcha.body')}</Text>
      <TurnstileChallenge siteKey={TURNSTILE_SITE_KEY} onToken={(token) => captchaGate.resolve(token)} />
    </AppModal>
  )
}
