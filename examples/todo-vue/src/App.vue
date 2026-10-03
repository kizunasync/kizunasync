<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { Toaster, toast } from 'vue-sonner'
import 'vue-sonner/style.css'
import { subscribeVerdictToasts } from 'kizunasync'
import { openKizunaSync, recordEngineEvent, type IKizunaSyncShim } from './kizunasync'
import { messageOf } from '@kizunasync/utilities'
import { settings } from './settings'
import type { TTab } from './tabs'
import BrandHeader from './components/BrandHeader.vue'
import TopNav from './components/TopNav.vue'
import TodoView from './components/TodoView.vue'
import CacheView from './components/CacheView.vue'
import SettingsView from './components/SettingsView.vue'

// MARK: - Root

/**
 * openKizunaSync() builds the client during setup and opens nothing; the
 * engine's worker starts on the first call that needs it. A client that cannot
 * be built shows its error instead. The client is passed to every view as a
 * prop. The segmented nav (TODO | Cache | Settings) is reactive tab state here:
 * a top bar on large screens, a bottom segment on small ones (CSS media query).
 * dispose() tears the worker down with the component.
 */
const client = ref<IKizunaSyncShim | null>(null)
const bootError = ref<string | null>(null)
const tab = ref<TTab>('todo')

let stopToasts: (() => void) | undefined
let stopEngineEvents: (() => void) | undefined
let stopLiveWatch: (() => void) | undefined
let stopOfflineWatch: (() => void) | undefined

try {
  const kizunasync = openKizunaSync()

  client.value = kizunasync
  stopToasts = subscribeVerdictToasts(kizunasync, (message) =>
    (message.level === 'error' ? toast.error : toast.warning)(
      `${message.title}: ${message.message}`,
    ),
  )
  // The single client.on() subscription that feeds the Cache tab's "Engine events" ring: recordEngineEvent's module-scope buffer lives in kizunasync.ts, this is its one writer.
  stopEngineEvents = kizunasync.on((event) => recordEngineEvent(event))
  // Bound here (not in SettingsView) so the engine reflects `settings` from first load, whichever tab is open first: SettingsView only exists once the Settings tab has been visited, under the tabs' <KeepAlive> v-if.
  stopLiveWatch = watch(() => settings.live, (v) => kizunasync.setLiveSync(v), { immediate: true })
  stopOfflineWatch = watch(() => settings.offline, (v) => kizunasync.setOffline(v), { immediate: true })
} catch (reason) {
  bootError.value = messageOf(reason)
}

onBeforeUnmount(() => {
  stopToasts?.()
  stopEngineEvents?.()
  stopLiveWatch?.()
  stopOfflineWatch?.()
  client.value?.dispose()
})
</script>

<template>
  <Toaster position="top-center" theme="dark" rich-colors />
  <main v-if="client === null" class="page">
    <section class="card">
      <BrandHeader />
      <p class="error">{{ bootError }}</p>
    </section>
  </main>
  <div v-else class="app">
    <TopNav :active="tab" placement="top" :client="client" @select="tab = $event" />
    <div class="app-body">
      <div class="column">
        <KeepAlive>
          <TodoView v-if="tab === 'todo'" :client="client" />
          <CacheView v-else-if="tab === 'cache'" :client="client" />
          <SettingsView v-else :client="client" />
        </KeepAlive>
      </div>
    </div>
    <TopNav :active="tab" placement="bottom" :client="client" @select="tab = $event" />
  </div>
</template>
