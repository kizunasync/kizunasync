/**
 * Messages the framework bindings share. A binding that resolves the client
 * from its own provider (@kizunasync/react's context, @kizunasync/vue's provide scope)
 * fails loud with the SAME text, so a reader who moves between the two
 * frameworks, and a docs page that quotes the failure, has one string to match.
 */
// MARK: - Shared binding messages

/** Thrown by useKizunaSync when neither the { client } override nor a provider resolved. */
export const MISSING_CLIENT_MESSAGE =
  'useKizunaSync: no Kizuna client found. Pass an explicit { client }, or provide one from an ancestor: ' +
  '<KizunaSyncProvider client={kizunasync}> in React, provideKizunaSync(kizunasync) in Vue.'
