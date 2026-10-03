<script setup lang="ts">
import type { TOverwriteRecord } from '@kizunasync/core'
import { formatRelativeTime } from '@kizunasync/utilities'
import ModalShell from './ModalShell.vue'

// MARK: - Overwrites panel

/**
 * A rejection is a write the server refused; an overwrite is a write it
 * accepted whose column another device had already won. Every row shows the
 * resolution mode, the table and column, the value this device lost, and a
 * relative time, with a per-row Dismiss. The parent (TopNav) owns the live list
 * via useOverwrites and threads it in through props so this stays a plain
 * rendering component.
 */

/** A column value is any JSON, and a long one would swamp the row. */
const LOSER_VALUE_MAX_LENGTH = 60

defineProps<{ overwrites: TOverwriteRecord[]; error: Error | null }>()
const emit = defineEmits<{
  dismiss: [id: number]
  close: []
}>()

function describeLoser(value: unknown): string {
  if (value === null || value === undefined) {
    return 'an empty value'
  }
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)

  if (rendered === undefined || rendered.length > LOSER_VALUE_MAX_LENGTH) {
    return 'your value'
  }
  return `"${rendered}"`
}
</script>

<template>
  <ModalShell title="Overwrites" title-id="overwrites-title" @dismiss="emit('close')">
    <p v-if="error !== null" class="error">{{ error.message }}</p>
    <p v-else-if="overwrites.length === 0" class="cache-empty">
      No overwrites. Columns another device wins will appear here.
    </p>
    <div v-else class="cache-list">
      <div v-for="overwrite in overwrites" :key="overwrite.id" class="verdict-row">
        <div class="queue-head">
          <span class="verdict-chip">{{ overwrite.conflictMode }}</span>
          <span class="log-meta">{{ formatRelativeTime(overwrite.at) }}</span>
        </div>
        <span class="verdict-reason">
          {{ overwrite.table }}.{{ overwrite.column }}: another device won, so
          {{ describeLoser(overwrite.loserValue) }} was replaced.
        </span>
        <div class="modal-actions">
          <button type="button" class="modal-button" @click="emit('dismiss', overwrite.id)">
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
