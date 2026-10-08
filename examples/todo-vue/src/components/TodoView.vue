<script setup lang="ts">
/**
 * Todo board. Normal CRUD goes through the kizunasync wrapper in front of
 * supabase-js over the browser worker store. supabase-js owns auth: the
 * signed-in session drives server RLS. The conflict lab alone makes one
 * direct out-of-band Supabase update. Reads and writes hit local SQLite;
 * kizunasync.sync() reconciles with Supabase over the fenced RPC. Live-sync,
 * edit-anyone, and offline controls live in Settings (shared reactive
 * `settings`); the board reads them.
 *
 * State concerns split into the composables under ../composables/: account
 * identity and the switch/recover flow, the reset after a replaced identity,
 * the read/write test actions, the add-todo composer, the live outbox depth,
 * and the sort/filter list. What stays here: the query/sync-status wiring,
 * the shared `mutate` write wrapper (every composable that writes takes it as
 * a parameter, since `writeError` feeds the `error`/`note` computed below),
 * the edit modal's local state, and the per-row toggle/delete handlers the
 * template calls directly.
 */

import { computed, ref } from 'vue'
import { ESoftBlockReason, type TColumnValues } from 'kizunasync'
import { useQuery, useSyncStatus } from 'kizunasync/vue'
import { t } from '../i18n'
import { createUiConnectivity, previewUrlForFile, type IKizunaSyncShim } from '../kizunasync'
import { ARCHIVED_COLUMN, formatClockTime, isTodoArchived, isTodoEditable, isTodoMine, REGISTERED_UID_NAMES, TITLE_MAX_LENGTH, TODOS_TABLE } from '@kizunasync/utilities'
import { settings } from '../settings'
import SwitchGuardModal from './SwitchGuardModal.vue'
import EditTodoModal from './EditTodoModal.vue'
import SkeletonList from './SkeletonList.vue'
import TodoThumb from './TodoThumb.vue'
import RowIcon from './RowIcon.vue'
import { ACCOUNTS, useAccountSwitch, type IAccount } from '../composables/use-account-switch'
import { useBoardActions } from '../composables/use-board-actions'
import { useBoardFilter } from '../composables/use-board-filter'
import { useIdentityRecovery } from '../composables/use-identity-recovery'
import { usePendingWrites } from '../composables/use-pending-writes'
import { useTodoComposer } from '../composables/use-todo-composer'
import { FILTER_OPTIONS, type ITodo, type TMutate } from '../composables/types'

// MARK: - Kizuna web todo

const props = defineProps<{ client: IKizunaSyncShim }>()

// MARK: - Query + sync status

const { data, error: queryError, isLoading } = useQuery(
  (kizunasync) => kizunasync.from(TODOS_TABLE).select(),
  { client: props.client },
)

const { outboxDepth, isSyncing, isOnline, lastError, needsReset, softBlockReason, health, syncNow } = useSyncStatus({
  client: props.client,
  connectivity: createUiConnectivity(),
})

// MARK: - Write wrapper

const writeError = ref<Error | null>(null)

const mutate: TMutate = async (fn, op, label) => {
  writeError.value = null
  const started = Date.now()

  try {
    await fn(props.client)
    props.client.queryLog.record({ op, label, rows: 1, ms: Date.now() - started })
  } catch (cause) {
    writeError.value = cause instanceof Error ? cause : new Error(String(cause))
  }
}

// MARK: - Cross-cutting state

const message = ref<string | null>(null)
const firstLoadPending = ref(true)
const editing = ref<ITodo | null>(null)

// MARK: - Composables

const {
  account,
  myId,
  pendingSwitch,
  pendingLabel,
  requestSwitch,
  confirmSyncThenSwitch,
  confirmSwitchAnyway,
  cancelSwitch,
} = useAccountSwitch({
  client: props.client,
  isOnline,
  outboxDepth,
  syncNow,
  onMessage: (next) => {
    message.value = next
  },
  onFirstLoadPending: (pending) => {
    firstLoadPending.value = pending
  },
})

const { todos, statusFilter, search, visibleTodos } = useBoardFilter({ data, myId })

const { isResetting, runRead, deleteAll, createPredefined, editAll, rebuildLocalDatabase } = useBoardActions({
  client: props.client,
  mutate,
  todos,
  myId,
  syncNow,
  onMessage: (next) => {
    message.value = next
  },
})

const { title, addImageUri, addFileInput, submit, pickAddImage, onAddImagePicked } = useTodoComposer({
  client: props.client,
  myId,
  mutate,
})

useIdentityRecovery({
  client: props.client,
  syncNow,
  onMessage: (next) => {
    message.value = next
  },
})

const queueDepth = usePendingWrites(props.client, outboxDepth)

// MARK: - Sync bar live state

const lastSyncLabel = computed(() =>
  health.value.lastSuccessAt === null ? 'Not synced yet' : `Last sync ${formatClockTime(health.value.lastSuccessAt)}`,
)

const resetBannerBody = computed(() =>
  softBlockReason.value === ESoftBlockReason.identityChanged
    ? "This device's local data belongs to another user than the one signed in, so nothing syncs until it is rebuilt."
    : 'The server refused this client, so nothing syncs until the local database is rebuilt.',
)

const error = computed(() => queryError.value ?? writeError.value ?? lastError.value)
const note = computed(() => message.value ?? error.value?.message ?? null)
const syncBarText = computed(() => {
  const parts = [
    isOnline.value ? t('sync.online') : t('sync.offline'),
    t('sync.outbox', { count: queueDepth.value }),
    lastSyncLabel.value,
  ]

  if (note.value !== null) {
    parts.push(note.value)
  }
  return parts.join(' · ')
})
const showSkeleton = computed(() => todos.value.length === 0 && (isLoading.value || firstLoadPending.value))

// MARK: - Methods

/**
 * Commit the modal's title + image intent through the same mutate path as
 * toggle/add, so it syncs and reconciles like them. A replace imports the
 * picked file via the attachment port, whose fromFile writes the resulting REF
 * into image_path (a normal synced column); a removal nulls image_path; title
 * always updates.
 */
async function saveEdit(payload: {
  title: string
  imageFile: File | null
  removeImage: boolean
}): Promise<void> {
  const todo = editing.value

  if (todo === null) {
    return
  }
  editing.value = null
  await mutate(async (k) => {
    const values: TColumnValues = { title: payload.title }

    if (payload.removeImage) {
      values.image_path = null
    } else if (payload.imageFile !== null) {
      await props.client.attachments.fromFile({
        table: TODOS_TABLE,
        column: 'image_path',
        pk: todo.id,
        uri: previewUrlForFile(payload.imageFile),
      })
    }
    await k.from(TODOS_TABLE).update(values).eq('id', todo.id)
  }, 'UPDATE', 'todos · edit')
}

function toggleDone(todo: ITodo): void {
  void mutate(
    (k) => k.from(TODOS_TABLE).update({ done: !todo.done }).eq('id', todo.id),
    'UPDATE',
    'todos · toggle done',
  )
}

function remove(todo: ITodo): void {
  void mutate((k) => k.from(TODOS_TABLE).delete().eq('id', todo.id), 'DELETE', 'todos · delete')
}

function rowClass(todo: ITodo): string {
  return [
    'item',
    isEditable(todo) ? '' : 'is-locked',
    isTodoArchived(todo) ? 'is-archived' : '',
  ].filter(Boolean).join(' ')
}

function archiveTodo(todo: ITodo): void {
  void mutate(
    (k) => k.from(TODOS_TABLE).update({ [ARCHIVED_COLUMN]: new Date().toISOString() }).eq('id', todo.id),
    'UPDATE',
    'todos · archive',
  )
}

function restoreTodo(todo: ITodo): void {
  void mutate(
    (k) => k.from(TODOS_TABLE).update({ [ARCHIVED_COLUMN]: null }).eq('id', todo.id),
    'UPDATE',
    'todos · restore',
  )
}

function isMine(todo: ITodo): boolean {
  return isTodoMine(todo, myId.value)
}

/**
 * Owner badge text (display-only, does NOT gate editing): my row → "you"; a
 * registered user's row → that user's display name; an anonymous/unknown owner
 * → "visitor".
 */
function ownerLabel(todo: ITodo): string {
  if (isMine(todo)) {
    return t('item.you')
  }
  return REGISTERED_UID_NAMES[todo.user_id] ?? t('item.shared')
}

/**
 * Any visitor's row is editable on the shared board. The `editAnyone` test flag
 * lifts the local guard on a registered user's row; the server still returns
 * RLS_DENIED and the engine reverts the optimistic edit.
 */
function isEditable(todo: ITodo): boolean {
  return isTodoEditable(todo, { myId: myId.value, editAnyone: settings.editAnyone })
}

function pillClass(candidate: IAccount): string {
  const active = account.value === candidate.key
  const disabled = !isOnline.value && !active

  return [active ? 'pill is-active' : 'pill', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')
}
</script>

<template>
  <section class="screen">
    <div v-if="needsReset" class="reset-banner" role="alert">
      <p class="reset-banner-title">Sync is blocked</p>
      <p class="reset-banner-body">
        {{ resetBannerBody }}
        <template v-if="queueDepth > 0">
          {{ queueDepth }} unsynced {{ queueDepth === 1 ? 'write' : 'writes' }} will be lost.
        </template>
      </p>
      <button type="button" class="sync-now" :disabled="isResetting" @click="void rebuildLocalDatabase()">
        {{ isResetting ? 'Resetting' : 'Reset local data' }}
      </button>
    </div>

    <p class="section-title">Users</p>
    <div class="account-row" role="group" :aria-label="t('account.switch')">
      <button
        v-for="candidate in ACCOUNTS"
        :key="candidate.key"
        type="button"
        :class="pillClass(candidate)"
        :aria-pressed="account === candidate.key"
        :disabled="!isOnline && account !== candidate.key"
        @click="requestSwitch(candidate.key)"
      >
        {{ candidate.label }}
      </button>
    </div>

    <p class="share-note">{{ t('share.note') }}</p>

    <p class="section-title">Connection</p>
    <div class="sync-bar">
      <button
        type="button"
        class="sync-toggle"
        :aria-pressed="!settings.offline"
        :aria-label="settings.offline ? 'Go online' : 'Go offline'"
        @click="settings.offline = !settings.offline"
      >
        <span :class="isOnline ? 'dot is-online' : 'dot is-offline'" aria-hidden="true" />
        <span class="sync-text" role="status">{{ syncBarText }}</span>
        <span :class="settings.offline ? 'switch' : 'switch is-on'" aria-hidden="true">
          <span class="switch-knob" />
        </span>
      </button>
      <button type="button" class="sync-now" :disabled="isSyncing" @click="void syncNow()">
        {{ isSyncing ? t('sync.syncing') : t('sync.now') }}
      </button>
    </div>

    <hr class="actions-divider" />

    <p class="section-title">Actions</p>
    <div class="actions" role="group" aria-label="Read and write tests">
      <button type="button" class="read-button" @click="void runRead('todos · fetch all', false, false)">
        Fetch all
      </button>
      <button type="button" class="read-button" @click="void runRead('todos · order created asc', true, false)">
        Sort created ASC
      </button>
      <button type="button" class="read-button" @click="void runRead('todos · order created desc', false, false)">
        Sort created DESC
      </button>
      <button type="button" class="read-button" @click="void runRead('todos · mine first', false, true)">
        Sort mine first
      </button>
      <button type="button" class="read-button" @click="void deleteAll()">Delete all</button>
      <button
        type="button"
        class="read-button"
        :disabled="myId === null"
        @click="void createPredefined()"
      >
        Create predefined
      </button>
      <button type="button" class="read-button" @click="void editAll()">Edit all</button>
    </div>

    <hr class="actions-divider" />

    <p class="section-title">Todos</p>
    <form class="add-form" @submit.prevent="submit">
      <input
        v-model="title"
        class="add-input"
        :maxlength="TITLE_MAX_LENGTH"
        :aria-label="t('add.placeholder')"
        :placeholder="t('add.placeholder')"
      />
      <button
        type="button"
        :class="addImageUri !== null ? 'icon-button is-active' : 'icon-button'"
        aria-label="Add image"
        @click="pickAddImage"
      >
        <span aria-hidden="true">{{ addImageUri !== null ? '🖼✓' : '🖼' }}</span>
      </button>
      <input
        ref="addFileInput"
        type="file"
        accept="image/*"
        class="edit-file"
        @change="onAddImagePicked"
      />
      <button class="add-button" type="submit">{{ t('add.button') }}</button>
    </form>

    <div class="filter-row">
      <div class="segment" role="group" aria-label="Filter todos">
        <button
          v-for="option in FILTER_OPTIONS"
          :key="option.value"
          type="button"
          :class="statusFilter === option.value ? 'segment-button is-active' : 'segment-button'"
          :aria-pressed="statusFilter === option.value"
          @click="statusFilter = option.value"
        >
          {{ option.label }}
        </button>
      </div>
      <input
        v-model="search"
        class="add-input filter-search"
        type="search"
        aria-label="Search todos"
        placeholder="Search todos…"
      />
    </div>

    <SkeletonList v-if="showSkeleton" />
    <div v-else-if="todos.length === 0" class="empty">
      <span class="empty-glyph" aria-hidden="true">絆</span>
      <p class="empty-title">{{ t('empty.title') }}</p>
      <p class="empty-hint">{{ t('empty.hint') }}</p>
    </div>
    <p v-else-if="visibleTodos.length === 0" class="cache-empty">No todos match.</p>
    <ul v-else class="list">
      <li
        v-for="todo in visibleTodos"
        :key="todo.id"
        :class="rowClass(todo)"
      >
        <button
          type="button"
          class="item-main"
          :aria-pressed="todo.done"
          :disabled="!isEditable(todo)"
          @click="toggleDone(todo)"
        >
          <span :class="todo.done ? 'checkbox is-done' : 'checkbox'" aria-hidden="true">✓</span>
          <TodoThumb :image-path="todo.image_path" :client="props.client" />
          <span :class="todo.done ? 'item-title is-done' : 'item-title'">{{ todo.title }}</span>
          <span :class="isMine(todo) ? 'chip is-mine' : 'chip'">
            {{ ownerLabel(todo) }}
          </span>
          <span v-if="isTodoArchived(todo)" class="chip">{{ t('item.archived') }}</span>
        </button>
        <button
          v-if="isEditable(todo)"
          type="button"
          class="icon-button"
          aria-label="Edit"
          @click="editing = todo"
        >
          <RowIcon name="edit" />
        </button>
        <button
          v-if="isEditable(todo)"
          type="button"
          class="icon-button"
          :aria-label="isTodoArchived(todo) ? t('item.restore') : t('item.archive')"
          @click="isTodoArchived(todo) ? restoreTodo(todo) : archiveTodo(todo)"
        >
          <RowIcon :name="isTodoArchived(todo) ? 'restore' : 'archive'" />
        </button>
        <button
          v-if="isEditable(todo)"
          type="button"
          class="icon-button"
          :aria-label="t('item.delete')"
          @click="remove(todo)"
        >
          <RowIcon name="deleteForever" />
        </button>
      </li>
    </ul>

    <SwitchGuardModal
      v-if="pendingSwitch !== null"
      :target-label="pendingLabel"
      :unsynced-count="outboxDepth"
      :is-syncing="isSyncing"
      @sync-then-switch="void confirmSyncThenSwitch()"
      @switch-anyway="confirmSwitchAnyway"
      @cancel="cancelSwitch"
    />

    <EditTodoModal
      v-if="editing !== null"
      :title="editing.title"
      :image-path="editing.image_path"
      :client="props.client"
      @save="(payload) => void saveEdit(payload)"
      @cancel="editing = null"
    />
  </section>
</template>
