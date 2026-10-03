import { Linking, StyleSheet } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes'
import { EThemeColor } from '../theme'
import { buildTurnstileDocument, parseTurnstileMessage, TURNSTILE_ACTION, TURNSTILE_DOCUMENT_ORIGIN } from '../lib/turnstile-document'

/**
 * The Cloudflare Turnstile check on iOS and Android: a WebView over an inline
 * page (@../lib/turnstile-document.ts). Expo web renders the DOM widget from
 * `turnstile-challenge.web.tsx` instead, so the WebView never enters that bundle.
 */
export function TurnstileChallenge({ siteKey, onToken }: { siteKey: string; onToken: (token: string | null) => void }) {
  const onMessage = (event: WebViewMessageEvent): void => {
    const message = parseTurnstileMessage(event.nativeEvent.data)

    if (message === null) {
      return
    }
    onToken(message.kind === 'token' ? message.token : null)
  }

  return (
    <WebView
      style={styles.webview}
      source={{ html: buildTurnstileDocument({ siteKey, action: TURNSTILE_ACTION }), baseUrl: TURNSTILE_DOCUMENT_ORIGIN }}
      originWhitelist={['*']}
      javaScriptEnabled
      domStorageEnabled
      setSupportMultipleWindows={false}
      scrollEnabled={false}
      onMessage={onMessage}
      onShouldStartLoadWithRequest={allowChallengeRequest}
    />
  )
}

/** The challenge iframe and the initial document load inside the WebView; any other top-frame link (the widget's privacy and help pages) opens in the system browser. */
function allowChallengeRequest(request: ShouldStartLoadRequest): boolean {
  if (request.isTopFrame === false || request.url.startsWith(TURNSTILE_DOCUMENT_ORIGIN) || request.url.startsWith('about:')) {
    return true
  }
  void Linking.openURL(request.url).catch(() => undefined)

  return false
}

const styles = StyleSheet.create({
  webview: { height: 65, backgroundColor: EThemeColor.surfaceElevated },
})
