import { useEffect, useState, type ReactNode } from 'react'
import { Toaster, toast } from 'sonner'
import { subscribeVerdictToasts } from '@kizunasync/core'
import { KizunaSyncProvider } from '@kizunasync/react'
import { openKizunaSync, recordEngineEvent, type IKizunaSyncShim } from './kizunasync'
import { t } from './i18n'
import { messageOf } from '@kizunasync/utilities'
import { BottomNav, TopNav, type TTab } from './components/top-nav'
import { SettingsProvider, type IBoardOrder, type ISettings } from './components/settings-context'
import { TodoBoard } from './components/todo-board'
import { CacheView } from './components/cache-view'
import { SettingsView } from './components/settings-view'
import { SkeletonBoard } from './components/skeleton'
import { Brand, TopNavBrand } from './components/brand-header'

// MARK: - Kizuna web todo

/**
 * A multi-tab app that mirrors the Expo example's web layout: a segmented
 * TODO / Cache / Settings nav over the kizunasync wrapper in front of supabase-js.
 * Normal todo CRUD goes through kizunasync.from('todos') over the browser worker
 * store. The conflict lab alone performs a direct Supabase update to
 * create an out-of-band change. The nav has no router: the active tab is
 * in-component state, matching expo-router's router.replace tab semantics.
 */

// MARK: - Root

export default function App() {
  const [client, setClient] = useState<IKizunaSyncShim | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    try {
      setClient(openKizunaSync())
    } catch (reason) {
      setBootError(messageOf(reason))
    }
  }, [])

  // A toast on every server verdict (rejection / abort / dead-letter), wording from the shared verdictToMessage so React, Vue and Expo agree.
  useEffect(() => {
    if (client === null) {
      return
    }
    return subscribeVerdictToasts(client, (message) =>
      (message.level === 'error' ? toast.error : toast.warning)(
        `${message.title}: ${message.message}`,
      ),
    )
  }, [client])

  // The single client.on() subscription feeding the Cache tab's "Engine events" ring: recordEngineEvent's module-scope buffer lives in kizunasync.ts.
  useEffect(() => {
    if (client === null) {
      return
    }
    return client.on(recordEngineEvent)
  }, [client])

  if (bootError !== null) {
    return (
      <Shell>
        <p className="error">{bootError}</p>
      </Shell>
    )
  }

  if (client === null) {
    return (
      <Shell>
        <SkeletonBoard />
      </Shell>
    )
  }

  return (
    <KizunaSyncProvider client={client}>
      <Toaster position="top-center" theme="dark" richColors />
      <Workspace client={client} />
    </KizunaSyncProvider>
  )
}

// MARK: - Workspace

function Workspace({ client }: { client: IKizunaSyncShim }) {
  // MARK: - Variables
  const [tab, setTab] = useState<TTab>('todo')
  const [editAnyone, setEditAnyone] = useState(false)
  const [live, setLiveState] = useState(true)
  const [offline, setOfflineState] = useState(false)
  const [boardOrder, setBoardOrder] = useState<IBoardOrder>({
    orderBy: 'created_at',
    ascending: false,
    mineFirst: false,
  })

  // MARK: - Methods

  function setLive(value: boolean): void {
    setLiveState(value)
    client.setLiveSync(value)
  }

  function setOffline(value: boolean): void {
    setOfflineState(value)
    client.setOffline(value)
  }

  const settings: ISettings = {
    editAnyone,
    setEditAnyone,
    live,
    setLive,
    offline,
    setOffline,
    boardOrder,
    setBoardOrder,
  }

  // MARK: - render
  return (
    <SettingsProvider value={settings}>
      <div className="app">
        <TopNav active={tab} onSelect={setTab} />
        <main className="app-main">
          {tab === 'todo' ? <TodoBoard client={client} /> : null}
          {tab === 'cache' ? <CacheView /> : null}
          {tab === 'settings' ? <SettingsView client={client} /> : null}
        </main>
        <BottomNav active={tab} onSelect={setTab} />
      </div>
    </SettingsProvider>
  )
}

// MARK: - Pieces

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="topnav">
        <div className="topnav-inner">
          <TopNavBrand />
        </div>
      </header>
      <main className="app-main">
        <div className="column">
          <Brand sub={t('brand.subtitle')} />
          {children}
        </div>
      </main>
    </div>
  )
}
