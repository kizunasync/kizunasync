import { StyleSheet, View } from 'react-native'
import { TurnstileWidget } from '@kizunasync/ui'
import { TURNSTILE_ACTION } from '../lib/turnstile-document'

/** The Cloudflare Turnstile check on Expo web: the DOM widget the web demo uses. */
export function TurnstileChallenge({ siteKey, onToken }: { siteKey: string; onToken: (token: string | null) => void }) {
  return (
    <View style={styles.host}>
      <TurnstileWidget siteKey={siteKey} action={TURNSTILE_ACTION} theme="dark" onToken={onToken} className="" />
    </View>
  )
}

const styles = StyleSheet.create({
  host: { minHeight: 65 },
})
