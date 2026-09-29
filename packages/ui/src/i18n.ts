/**
 * Framework-agnostic i18n for the three todo examples: plain TypeScript that
 * React, Vue, and React Native all import the same way. The English dictionary
 * is the canonical contract: TLocaleKey is derived from it, and every other
 * locale must supply exactly the same keys (the TDictionary type enforces it
 * at compile time). No framework dependency, no runtime locale loading: both
 * dictionaries ship in the bundle.
 */

// MARK: - Types

/** Supported locales. English is the source of truth; Italian mirrors its keys. */
export type TLocale = 'en' | 'it'

/**
 * Interpolation variables for a single t() call. Values are stringified as-is;
 * keys are matched against `{name}` placeholders in the message.
 */
export type TTranslationVars = Record<string, string | number>

const EN = {
  'brand.name': 'Kizuna Sync',
  'brand.subtitle': 'offline todo',

  'account.switch': 'Switch account',
  'account.anonymous': 'anonymous',
  'account.switching': 'switching to {name}…',
  'account.synced': '{name} · synced',

  'share.note':
    'Shared board: every visitor sees and edits every visitor’s todos. The seeded registered users’ rows are readable by everyone and writable only by their owner; a non-owner edit on one of those is refused by RLS and reverted.',

  'sync.online': 'online',
  'sync.offline': 'offline',
  'sync.outbox': 'outbox {count}',
  'sync.syncing': 'syncing…',
  'sync.now': 'sync now',

  'add.placeholder': 'What needs doing? (works offline)',
  'add.button': 'add',

  'empty.title': 'Nothing here yet',
  'empty.hint': 'Add your first todo above, then try airplane mode and watch it sync.',

  'item.you': 'you',
  'item.shared': 'visitor',
  'item.delete': 'delete',

  'settings.title': 'settings',
  'settings.editAnyone': 'Test non-owner edit',
  'settings.editAnyone.hint':
    'Lift the read-only guard on the registered users’ rows so you can toggle/delete them and watch the server’s RLS_DENIED revert.',
  'settings.liveSync': 'Live sync',
  'settings.liveSync.hint':
    'When on, the app syncs by itself as you make changes and on a timer. When off, it syncs only when you press "sync now".',

  'warning.accountSwitch':
    'Switching accounts wipes this device’s local database and re-hydrates the rows visible to the new identity. Unsynced changes will be lost.',

  'cache.outboxDepth.title': 'Outbox depth',
  'cache.outboxDepth.body':
    'Local mutations queued and waiting to push to the server. Live sync auto-pushes within ~250ms of every edit, so this is normally 0, and that is healthy, not broken. To watch it grow, switch on Offline in Settings and add or edit todos: the queue holds them until you go back online, then drains as each one pushes.',
  'cache.cursor.title': 'Cursor',
  'cache.cursor.body':
    'This device’s durable sync position: how far through the server’s change-log it has pulled. It only moves when you pull new server changes, so a steady value just means nothing new has arrived since the last pull. "Expire checkpoint" in Settings rewinds it so the next sync re-walks history from the start.',
  'cache.lastMutationId.title': 'Last mutation id',
  'cache.lastMutationId.body':
    'The id of the most recent local change the server confirmed as applied: the exactly-once watermark sent on the next push so a retry can never double-apply. It stays empty until one of your own local edits is successfully pushed; a pull-only session, or a push that was rejected (e.g. an RLS denial), never sets it. Add or edit a todo while signed in, then sync, to populate it.',
} as const

/** Every translatable string key, derived from the canonical English dictionary. */
export type TLocaleKey = keyof typeof EN

/** A locale's full string table: must cover exactly the canonical key set. */
export type TDictionary = Record<TLocaleKey, string>

// MARK: - Constants

export const DEFAULT_LOCALE: TLocale = 'en'

const IT: TDictionary = {
  'brand.name': 'Kizuna Sync',
  'brand.subtitle': 'todo offline',

  'account.switch': 'Cambia account',
  'account.anonymous': 'anonimo',
  'account.switching': 'passaggio a {name}…',
  'account.synced': '{name} · sincronizzato',

  'share.note':
    'Bacheca condivisa: ogni visitatore vede e modifica i todo di tutti gli altri visitatori. Le righe seed degli utenti registrati sono leggibili da tutti e scrivibili solo dal loro proprietario; una modifica non proprietaria su una di quelle viene rifiutata da RLS e annullata.',

  'sync.online': 'online',
  'sync.offline': 'offline',
  'sync.outbox': 'in coda {count}',
  'sync.syncing': 'sincronizzazione…',
  'sync.now': 'sincronizza ora',

  'add.placeholder': 'Cosa c’è da fare? (funziona offline)',
  'add.button': 'aggiungi',

  'empty.title': 'Ancora niente qui',
  'empty.hint':
    'Aggiungi il tuo primo todo qui sopra, poi prova la modalità aereo e guardalo sincronizzarsi.',

  'item.you': 'tu',
  'item.shared': 'visitatore',
  'item.delete': 'elimina',

  'settings.title': 'impostazioni',
  'settings.editAnyone': 'Prova modifica non proprietaria',
  'settings.editAnyone.hint':
    'Rimuovi il blocco di sola lettura sulle righe degli utenti registrati per attivarle/eliminarle e osservare l’annullamento dell’RLS_DENIED del server.',
  'settings.liveSync': 'Sincronizzazione live',
  'settings.liveSync.hint':
    'Se attiva, l’app si sincronizza da sola mentre fai modifiche e a intervalli regolari. Se disattiva, si sincronizza solo quando premi "sincronizza ora".',

  'warning.accountSwitch':
    'Cambiare account cancella il database locale di questo dispositivo e ricarica le righe visibili alla nuova identità. Le modifiche non sincronizzate andranno perse.',

  'cache.outboxDepth.title': 'Profondità della coda',
  'cache.outboxDepth.body':
    'Mutazioni locali in coda in attesa di essere inviate al server. La sincronizzazione live invia automaticamente entro circa 250ms da ogni modifica, quindi questo valore è normalmente 0: è un segno di salute, non un problema. Per vederlo crescere, attiva Offline nelle impostazioni e aggiungi o modifica i todo: la coda li trattiene finché non torni online, poi si svuota man mano che ognuno viene inviato.',
  'cache.cursor.title': 'Cursore',
  'cache.cursor.body':
    'La posizione di sincronizzazione durevole di questo dispositivo: quanto ha già ricevuto del registro delle modifiche del server. Si sposta solo quando ricevi nuove modifiche dal server, quindi un valore stabile significa solo che non è arrivato nulla di nuovo dall’ultima ricezione. "Scadi checkpoint" nelle impostazioni lo riporta indietro così la prossima sincronizzazione riattraversa la cronologia dall’inizio.',
  'cache.lastMutationId.title': 'Id ultima mutazione',
  'cache.lastMutationId.body':
    'L’id della modifica locale più recente confermata come applicata dal server: il segno esattamente-una-volta inviato al prossimo invio così un nuovo tentativo non può mai applicarsi due volte. Resta vuoto finché una delle tue modifiche locali non viene inviata con successo; una sessione di sola ricezione, o un invio rifiutato (per esempio un rifiuto RLS), non lo imposta mai. Aggiungi o modifica un todo da autenticato, poi sincronizza, per popolarlo.',
}

const DICTIONARIES: Record<TLocale, TDictionary> = {
  en: EN,
  it: IT,
}

// MARK: - Public API

/**
 * Resolve a key for a locale, substituting `{name}`-style placeholders. Unknown
 * locales fall back to DEFAULT_LOCALE; a placeholder with no matching var is left
 * verbatim so the gap is visible rather than silently blank.
 */
export function t(locale: TLocale, key: TLocaleKey, vars?: TTranslationVars): string {
  const table = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE]
  const message = table[key]

  if (vars === undefined) {
    return message
  }
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name]

    return value === undefined ? whole : String(value)
  })
}
