<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue'
import type { IInspectorSnapshot, IInspectorVerdict } from 'kizunasync'
import { formatRelativeTime, summarizeEngineEvent, type IQueryLogEntry, type TEngineEventLogEntry, type TQueryOp } from '@kizunasync/utilities'
import { t } from '../i18n'
import type { IKizunaSyncShim } from '../kizunasync'
import ModalShell from './ModalShell.vue'

// MARK: - Cache view

/**
 * The inspector is the engine's `inspect()` snapshot, read in the browser
 * worker: outbox depth/contents, the durable cursor, the last applied mutation
 * id, and a bounded ring of rejected/aborted verdicts. It is live: subscribe()
 * fires on every engine event, so we re-read the snapshot and verdicts on each
 * notification. The query log is the second live source: the reads and writes
 * the views record. A null inspector means devtools are off (the production
 * default); kizunasync.ts enables them with inspector:true.
 */
const props = defineProps<{ client: IKizunaSyncShim }>()

const LOG_RENDER_CAP = 150

const inspector = props.client.inspector ?? null
const queryLog = props.client.queryLog
const snapshot = ref<IInspectorSnapshot | null>(null)
const verdicts = ref<IInspectorVerdict[]>([])
const logEntries = ref<readonly IQueryLogEntry[]>(queryLog.entries())
const engineEvents = ref<readonly TEngineEventLogEntry[]>(props.client.engineEvents.read())

// MARK: - Op badge tone

const writeTone: Record<string, string> = {
  insert: 'is-insert',
  update: 'is-update',
  delete: 'is-delete',
}

const logTone: Record<TQueryOp, string> = {
  SELECT: 'is-select',
  INSERT: 'is-insert',
  UPDATE: 'is-update',
  DELETE: 'is-delete',
  PRAGMA: 'is-neutral',
  TX: 'is-neutral',
  OTHER: 'is-neutral',
}

const queued = computed(() =>
  (snapshot.value?.queued ?? []).slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
)
const recentVerdicts = computed(() => verdicts.value.slice().reverse())
const recentEngineEvents = computed(() => engineEvents.value.slice().reverse())
const visibleLog = computed(() => logEntries.value.slice(-LOG_RENDER_CAP).reverse())

if (inspector !== null) {
  let active = true
  const read = (): void => {
    void inspector.snapshot().then((next) => {
      if (active) {
        snapshot.value = next
      }
    })

    if (active) {
      verdicts.value = inspector.verdicts()
    }
  }
  read()
  const unsubscribe = inspector.subscribe(read)

  onScopeDispose(() => {
    active = false
    unsubscribe()
  })
}

const stopLog = queryLog.subscribe(() => {
  logEntries.value = queryLog.entries()
})

onScopeDispose(stopLog)

const stopEngineEvents = props.client.engineEvents.subscribe(() => {
  engineEvents.value = props.client.engineEvents.read()
})

onScopeDispose(stopEngineEvents)

// MARK: - Dialog state

type TDialogContent = { title: string; body?: string; rows?: [string, string][] }
const dialog = ref<TDialogContent | null>(null)

function closeDialog(): void {
  dialog.value = null
}

function openOutboxDepth(): void {
  dialog.value = {
    title: t('cache.outboxDepth.title'),
    body: t('cache.outboxDepth.body'),
    rows: [['current value', String(snapshot.value?.depth ?? 0)]],
  }
}

function openCursor(): void {
  dialog.value = {
    title: t('cache.cursor.title'),
    body: t('cache.cursor.body'),
    rows: [['current value', String(snapshot.value?.cursor ?? 'n/a')]],
  }
}

function openLastMutationId(): void {
  dialog.value = {
    title: t('cache.lastMutationId.title'),
    body: t('cache.lastMutationId.body'),
    rows: [['current value', snapshot.value?.lastMutationId ?? 'n/a']],
  }
}

function openQueueEntry(entry: NonNullable<IInspectorSnapshot['queued']>[number]): void {
  dialog.value = {
    title: 'Queued mutation',
    rows: [
      ['op', String(entry.op)],
      ['table', String(entry.table)],
      ['pk', String(entry.pk)],
      ['mutation id', String(entry.mutationId)],
      ['seq', String(entry.seq)],
      ['created at', String(entry.createdAt)],
      ['in-flight', entry.inFlight ? 'yes' : 'no'],
      ['batch id', entry.batchId ?? 'n/a'],
      ['hlc', entry.hlc ?? 'n/a'],
      ['columns', JSON.stringify(entry.columns)],
      ['precondition', entry.precondition ? JSON.stringify(entry.precondition) : 'n/a'],
    ],
  }
}

function openLogEntry(entry: IQueryLogEntry): void {
  dialog.value = {
    title: 'Operation',
    rows: [
      ['op', entry.op],
      ['label', entry.label],
      ['rows', entry.rows === null ? 'n/a' : String(entry.rows)],
      ['duration', `${entry.ms}ms`],
      ['seq', String(entry.seq)],
    ],
  }
}

function openVerdict(verdict: IInspectorVerdict): void {
  dialog.value = {
    title: 'Verdict',
    rows: [
      ['kind', verdict.kind],
      ['mutation id', verdict.mutationId],
      ['reason', String(verdict.reason)],
      ['at', verdict.at],
    ],
  }
}
</script>

<template>
  <section class="screen">
    <div class="screen-head">
      <span class="screen-glyph" aria-hidden="true">絆</span>
      <span class="screen-title">{{ t('brand.name') }}</span>
      <span class="screen-sub">debug</span>
    </div>

    <p v-if="inspector === null" class="cache-disabled">inspector disabled</p>

    <template v-else>
      <div class="stats-row">
        <div
          class="stat cache-clickable"
          role="button"
          tabindex="0"
          @click="openOutboxDepth"
          @keydown.enter="openOutboxDepth"
          @keydown.space.prevent="openOutboxDepth"
        >
          <span class="stat-label">outbox depth</span>
          <span class="stat-value">{{ snapshot?.depth ?? 0 }}</span>
        </div>
        <div
          class="stat cache-clickable"
          role="button"
          tabindex="0"
          @click="openCursor"
          @keydown.enter="openCursor"
          @keydown.space.prevent="openCursor"
        >
          <span class="stat-label">cursor</span>
          <span class="stat-value">{{ snapshot?.cursor ?? 'n/a' }}</span>
        </div>
      </div>
      <div
        class="stat stat-full cache-clickable"
        role="button"
        tabindex="0"
        @click="openLastMutationId"
        @keydown.enter="openLastMutationId"
        @keydown.space.prevent="openLastMutationId"
      >
        <span class="stat-label">last mutation id</span>
        <span class="stat-value">{{ snapshot?.lastMutationId ?? 'n/a' }}</span>
      </div>

      <hr class="cache-divider" />

      <p class="section-title">queued mutations</p>
      <p v-if="queued.length === 0" class="cache-empty">outbox empty: nothing waiting to push.</p>
      <div v-else class="cache-list">
        <div
          v-for="entry in queued"
          :key="entry.seq"
          class="queue-row cache-clickable"
          role="button"
          tabindex="0"
          @click="openQueueEntry(entry)"
          @keydown.enter="openQueueEntry(entry)"
          @keydown.space.prevent="openQueueEntry(entry)"
        >
          <div class="queue-head">
            <span class="op-badge" :class="writeTone[entry.op]">{{ entry.op }}</span>
            <span class="queue-table">{{ entry.table }}</span>
            <span v-if="entry.inFlight" class="in-flight-chip">in-flight</span>
          </div>
          <span class="queue-pk">pk {{ entry.pk }}</span>
        </div>
      </div>

      <hr class="cache-divider" />

      <div class="log-head">
        <p class="section-title">all operations</p>
      </div>
      <p v-if="visibleLog.length === 0" class="cache-empty">no operations recorded yet.</p>
      <div v-else class="cache-list">
        <div
          v-for="entry in visibleLog"
          :key="entry.seq"
          class="log-row cache-clickable"
          role="button"
          tabindex="0"
          @click="openLogEntry(entry)"
          @keydown.enter="openLogEntry(entry)"
          @keydown.space.prevent="openLogEntry(entry)"
        >
          <span class="op-badge" :class="logTone[entry.op]">{{ entry.op }}</span>
          <span class="log-label">{{ entry.label }}</span>
          <span class="log-meta">{{ entry.rows ?? 'n/a' }} rows · {{ entry.ms }}ms</span>
        </div>
      </div>

      <hr class="cache-divider" />

      <p class="section-title">recent verdicts</p>
      <p v-if="recentVerdicts.length === 0" class="cache-empty">no rejected or aborted mutations.</p>
      <div v-else class="cache-list">
        <div
          v-for="verdict in recentVerdicts"
          :key="`${verdict.mutationId}-${verdict.at}`"
          class="verdict-row cache-clickable"
          role="button"
          tabindex="0"
          @click="openVerdict(verdict)"
          @keydown.enter="openVerdict(verdict)"
          @keydown.space.prevent="openVerdict(verdict)"
        >
          <div class="queue-head">
            <span class="verdict-chip">{{ verdict.kind }}</span>
            <span class="verdict-id">{{ verdict.mutationId }}</span>
          </div>
          <span class="verdict-reason">{{ verdict.reason }}</span>
        </div>
      </div>

      <hr class="cache-divider" />

      <p class="section-title">Engine events</p>
      <p v-if="recentEngineEvents.length === 0" class="cache-empty">No events yet.</p>
      <div v-else class="cache-list">
        <div
          v-for="entry in recentEngineEvents"
          :key="`${entry.event.type}-${entry.at}`"
          class="verdict-row"
        >
          <div class="queue-head">
            <span class="verdict-chip">{{ entry.event.type }}</span>
            <span class="log-meta">{{ formatRelativeTime(entry.at) }}</span>
          </div>
          <span class="verdict-reason">{{ summarizeEngineEvent(entry.event) }}</span>
        </div>
      </div>
    </template>

    <ModalShell
      v-if="dialog !== null"
      :title="dialog.title"
      title-id="detail-dialog-title"
      @dismiss="closeDialog"
    >
      <p v-if="dialog.body" class="modal-body">{{ dialog.body }}</p>
      <dl v-if="dialog.rows" class="detail-list">
        <div v-for="([label, value]) in dialog.rows" :key="label">
          <dt>{{ label }}</dt>
          <dd>{{ value }}</dd>
        </div>
      </dl>
      <template #actions>
        <button type="button" class="modal-button" @click="closeDialog">Close</button>
      </template>
    </ModalShell>
  </section>
</template>
