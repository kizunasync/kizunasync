<script setup lang="ts">
import type { TRejectionRecord, TUuid } from 'kizunasync'
import { formatRelativeTime } from '@kizunasync/utilities'
import ModalShell from './ModalShell.vue'

// MARK: - Rejections panel

/**
 * Presentational shell over the durable rejection journal: every row shows its
 * kind, table + reason, and a relative time, with a per-row Dismiss. The parent
 * (TopNav) owns the live list via useRejections and threads it in through props
 * so this stays a plain rendering component.
 */

defineProps<{ rejections: TRejectionRecord[]; error: Error | null }>()
const emit = defineEmits<{
  dismiss: [mutationId: TUuid]
  close: []
}>()
</script>

<template>
  <ModalShell title="Rejections" title-id="rejections-title" @dismiss="emit('close')">
    <p v-if="error !== null" class="error">{{ error.message }}</p>
    <p v-else-if="rejections.length === 0" class="cache-empty">
      No rejections. Writes that the server refuses will appear here.
    </p>
    <div v-else class="cache-list">
      <div v-for="rejection in rejections" :key="rejection.mutationId" class="verdict-row">
        <div class="queue-head">
          <span class="verdict-chip">{{ rejection.kind }}</span>
          <span class="log-meta">{{ formatRelativeTime(rejection.at) }}</span>
        </div>
        <span class="verdict-reason">{{ rejection.table }}: {{ rejection.reason }}</span>
        <div class="modal-actions">
          <button type="button" class="modal-button" @click="emit('dismiss', rejection.mutationId)">
            Dismiss
          </button>
        </div>
      </div>
    </div>

    <template #actions>
      <button type="button" class="modal-button" @click="emit('close')">Close</button>
    </template>
  </ModalShell>
</template>
