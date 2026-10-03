<script setup lang="ts">
/**
 * `editAnyone` ("Test non-owner edit") lifts the local read-only guard on the
 * registered users' rows only, so a non-owner write hits RLS (RLS_DENIED, then
 * engine revert). "Live sync" is
 * the realtime switch: off ⇒ the client only syncs on a manual tap. The
 * Network "Offline (simulated)" toggle (default off) emulates airplane mode
 * through the shared `settings` flag: it queues mutations, suspends live
 * sync, and flushes on return (the TodoView SyncBar reads the same flag via
 * UI connectivity). This view only edits `settings`; the binding from
 * `settings` to the engine lives in App.vue so it is wired from first load,
 * whichever tab opens first. Force conflict, expire checkpoint, and reset
 * local stay as on-demand buttons here.
 */

import { ref } from 'vue'
import { t } from '../i18n'
import type { IKizunaSyncShim } from '../kizunasync'
import { settings } from '../settings'

// MARK: - Settings view

const props = defineProps<{ client: IKizunaSyncShim }>()

const message = ref<string | null>(null)

// MARK: - Methods

function runForceConflict(): void {
  void props.client.forceServerConflict().then((verdict) => {
    message.value = verdict
  })
}

function runExpireCheckpoint(): void {
  void props.client.expireCheckpoint().then(() => {
    message.value = 'cursor rewound: next sync re-walks history'
  })
}

function runResetLocal(): void {
  void props.client.resetLocal().then(() => {
    message.value = 'local wiped: sync to re-hydrate the RLS-visible rows'
  })
}
</script>

<template>
  <section class="screen">
    <div class="screen-head">
      <span class="screen-glyph" aria-hidden="true">絆</span>
      <span class="screen-title">{{ t('brand.name') }}</span>
      <span class="screen-sub">{{ t('settings.title') }}</span>
    </div>

    <p class="section-title">live sync</p>
    <button type="button" class="toggle-card" :aria-pressed="settings.live" @click="settings.live = !settings.live">
      <span class="toggle-text">
        <span class="toggle-label">{{ t('settings.liveSync') }}</span>
        <span class="toggle-hint">{{ t('settings.liveSync.hint') }}</span>
      </span>
      <span :class="settings.live ? 'switch is-on' : 'switch'">
        <span class="switch-knob" />
      </span>
    </button>

    <p class="section-title">network</p>
    <button
      type="button"
      class="toggle-card"
      :aria-pressed="settings.offline"
      @click="settings.offline = !settings.offline"
    >
      <span class="toggle-text">
        <span class="toggle-label">Offline (simulated)</span>
        <span class="toggle-hint">
          Queue mutations locally with no network. Live sync is suspended; flip back online to flush
          the outbox and resume.
        </span>
      </span>
      <span :class="settings.offline ? 'switch is-on' : 'switch'">
        <span class="switch-knob" />
      </span>
    </button>

    <p class="section-title">reconciliation</p>
    <button
      type="button"
      class="toggle-card"
      :aria-pressed="settings.editAnyone"
      @click="settings.editAnyone = !settings.editAnyone"
    >
      <span class="toggle-text">
        <span class="toggle-label">{{ t('settings.editAnyone') }}</span>
        <span class="toggle-hint">{{ t('settings.editAnyone.hint') }}</span>
      </span>
      <span :class="settings.editAnyone ? 'switch is-on' : 'switch'">
        <span class="switch-knob" />
      </span>
    </button>

    <p class="section-title">edge-case lab</p>
    <div class="lab">
      <div class="lab-row">
        <button type="button" class="lab-button" @click="runForceConflict">force conflict</button>
        <button type="button" class="lab-button" @click="runExpireCheckpoint">expire checkpoint</button>
        <button type="button" class="lab-button" @click="runResetLocal">reset local</button>
      </div>
      <p class="lab-hint">
        also try: airplane mode, kill the tab mid-outbox, two tabs on one account
      </p>
      <p v-if="message !== null" class="lab-message">{{ message }}</p>
    </div>
  </section>
</template>
