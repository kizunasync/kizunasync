<script setup lang="ts">
import { t } from '../i18n'
import ModalShell from './ModalShell.vue'

defineProps<{
  targetLabel: string
  unsyncedCount: number
  isSyncing: boolean
}>()

const emit = defineEmits<{
  syncThenSwitch: []
  switchAnyway: []
  cancel: []
}>()
</script>

<template>
  <ModalShell title="Unsynced changes" title-id="switch-guard-title" role="alertdialog" @dismiss="emit('cancel')">
    <p class="modal-body">
      You have {{ unsyncedCount }} unsynced change{{ unsyncedCount === 1 ? '' : 's' }}. Switching to
      {{ targetLabel }} wipes local data.
    </p>
    <template #actions>
      <button
        type="button"
        class="modal-button is-primary"
        :disabled="isSyncing"
        @click="emit('syncThenSwitch')"
      >
        {{ isSyncing ? t('sync.syncing') : t('sync.now') }}
      </button>
      <button type="button" class="modal-button is-danger" @click="emit('switchAnyway')">
        Switch anyway
      </button>
      <button type="button" class="modal-button" @click="emit('cancel')">Cancel</button>
    </template>
  </ModalShell>
</template>
