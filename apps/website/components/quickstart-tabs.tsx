import { CODE_THEME, getHighlighter } from '@/lib/code-highlight'
import { FrameworkTabs } from '@/components/framework-tabs'

// MARK: - QuickstartTabs

/**
 * Each panel below is its runtime guide's own bootstrap code
 * (docs/getting-started/react.md, vue.md, expo.md, native-clients.md,
 * vanilla-js.md): on the JavaScript tabs, the app client module and the root
 * file that provides it; on the Swift and Kotlin tabs, the final TodoSync file with the app client and its scheduler.
 * The guides are the source, and these tabs follow them.
 * Server component, highlighted once by the shared Shiki instance (same
 * site-dark theme as the docs), rendered through the existing FrameworkTabs
 * primitive, so every panel lands in the SSR HTML.
 */
const SNIPPETS = [
  {
    label: 'React',
    lang: 'tsx' as const,
    code: `// src/kizunasync.ts
import { byOwner, defineConfig } from 'kizunasync'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { createWebWorkerDriver } from 'kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
})

// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { KizunaSyncProvider } from 'kizunasync/react'
import { TodoList } from './components/todo-list'
import { kizunasync } from './kizunasync'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KizunaSyncProvider client={kizunasync}>
      <TodoList />
    </KizunaSyncProvider>
  </StrictMode>,
)`,
  },
  {
    label: 'Vue',
    lang: 'ts' as const,
    code: `// src/kizunasync.ts
import { byOwner, defineConfig } from 'kizunasync'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { createWebWorkerDriver } from 'kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
})

// src/main.ts
import { createApp } from 'vue'
import { createKizunaSyncPlugin } from 'kizunasync/vue'
import App from './App.vue'
import { kizunasync } from './kizunasync'

createApp(App).use(createKizunaSyncPlugin(kizunasync)).mount('#app')`,
  },
  {
    label: 'Expo/React Native',
    lang: 'tsx' as const,
    code: `// src/kizunasync.ts
import { byOwner, defineConfig } from 'kizunasync'
import { openExpoDriver } from 'kizunasync/expo'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: openExpoDriver('todos.db'),
  config,
})

// src/app/_layout.tsx
import { Stack } from 'expo-router'
import { KizunaSyncProvider } from 'kizunasync/react'
import { kizunasync } from '../kizunasync'

export default function RootLayout() {
  return (
    <KizunaSyncProvider client={kizunasync}>
      <Stack />
    </KizunaSyncProvider>
  )
}`,
  },
  {
    label: 'Swift',
    lang: 'swift' as const,
    code: `// TodoApp/TodoSync.swift
import Foundation
import KizunaSync
import Supabase

let kizunasync = KizunaSyncClient()

let syncScheduler = KizunaSyncScheduler(
  client: kizunasync,
  refreshSession: {
    guard let session = try? await supabase.auth.session else { return false }
    try? await kizunasync.setAccessToken(session.accessToken)
    return true
  },
  needsReset: { (try? await kizunasync.checkpoint().softBlocked) ?? false }
)

let kizunasyncReady = Task { @MainActor in
  let databaseURL = try FileManager.default
    .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    .appendingPathComponent("kizunasync.sqlite")
  try await kizunasync.create(KizunaSyncClientConfig(
    tables: ["todos": KizunaSyncTableConfig(bucket: .byOwner("user_id"))],
    databasePath: databaseURL.path,
    remote: KizunaSyncRemoteConfig(url: supabaseURL.absoluteString, publishableKey: supabasePublishableKey)
  ))
  syncScheduler.start()
}`,
  },
  {
    label: 'Kotlin',
    lang: 'kotlin' as const,
    code: `// app/src/main/kotlin/com/example/todo/TodoSync.kt
import android.content.Context
import com.kizunasync.kizunasync.KizunaSyncBucket
import com.kizunasync.kizunasync.KizunaSyncClient
import com.kizunasync.kizunasync.KizunaSyncClientConfig
import com.kizunasync.kizunasync.KizunaSyncConnectivityPathMonitor
import com.kizunasync.kizunasync.KizunaSyncProcessForegroundSource
import com.kizunasync.kizunasync.KizunaSyncRemoteConfig
import com.kizunasync.kizunasync.KizunaSyncScheduler
import com.kizunasync.kizunasync.KizunaSyncTableConfig
import io.github.jan.supabase.auth.auth
import java.io.File
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

val kizunasync = KizunaSyncClient()

lateinit var syncScheduler: KizunaSyncScheduler
    private set

private val openLock = Mutex()
private var isOpen = false

suspend fun openKizunaSync(context: Context) {
    openLock.withLock {
        if (!isOpen) {
            kizunasync.create(
                KizunaSyncClientConfig(
                    tables = mapOf("todos" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByOwner("user_id"))),
                    databasePath = File(context.filesDir, "kizunasync.sqlite").absolutePath,
                    remote = KizunaSyncRemoteConfig(url = SUPABASE_URL, publishableKey = SUPABASE_PUBLISHABLE_KEY),
                ),
            )
            syncScheduler = startSyncScheduler(context.applicationContext)
            isOpen = true
        }
    }
}

private fun startSyncScheduler(context: Context): KizunaSyncScheduler {
    val scheduler = KizunaSyncScheduler(
        client = kizunasync,
        refreshSession = {
            supabase.auth.awaitInitialization()
            val token = supabase.auth.currentSessionOrNull()?.accessToken
            if (token != null) {
                kizunasync.setAccessToken(token)
            }
            token != null
        },
        pathMonitor = KizunaSyncConnectivityPathMonitor(context),
        foregroundSource = KizunaSyncProcessForegroundSource(),
        needsResetSource = { runCatching { kizunasync.checkpoint().softBlocked }.getOrDefault(false) },
    )
    scheduler.start()
    return scheduler
}`,
  },
  {
    label: 'Vanilla / other',
    lang: 'ts' as const,
    code: `// src/kizunasync.ts
import { byOwner, defineConfig } from 'kizunasync'
import { createSupabaseKizunaSync } from 'kizunasync/supabase'
import { createWebWorkerDriver } from 'kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
})

// src/main.ts
import { mountTodoList } from './todo-list'

mountTodoList(document.querySelector<HTMLDivElement>('#app')!)`,
  },
] as const

export async function QuickstartTabs() {
  const highlighter = await getHighlighter()
  const groups = SNIPPETS.map((snippet) => ({
    label: snippet.label,
    code: snippet.code,
    html: highlighter.codeToHtml(snippet.code, { lang: snippet.lang, theme: CODE_THEME }),
  }))

  return <FrameworkTabs groups={groups} />
}
