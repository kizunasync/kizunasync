<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { IKizunaSync } from '@kizunasync/core'
import { useAttachment } from '@kizunasync/vue'
import { TITLE_MAX_LENGTH } from '@kizunasync/utilities'
import { t } from '../i18n'
import { previewUrlForFile } from '../kizunasync'
import ModalShell from './ModalShell.vue'
import Skeleton from './Skeleton.vue'

// MARK: - Edit-todo modal

/**
 * Prefilled title input plus an image section: a thumbnail when present, with
 * add / replace / remove controls over a hidden file input, the same File to
 * preview-url to upload path the add row uses. Save emits the next title and the
 * next image intent (a picked File to upload, or null to remove); the parent
 * commits one mutation through the shim. Cancel discards.
 */
const props = defineProps<{
  title: string
  imagePath: string | null
  client: IKizunaSync
}>()

const emit = defineEmits<{
  save: [payload: { title: string; imageFile: File | null; removeImage: boolean }]
  cancel: []
}>()

const draftTitle = ref(props.title)
const pickedFile = ref<File | null>(null)
const removed = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

/**
 * The existing image resolves through the attachment port (lazy-downloads a
 * peer's bytes on first view, the same path the row thumbnail uses), so it is
 * only watched while the draft still keeps the original image; a freshly
 * picked file previews from its object URL until Save.
 */
const kept = useAttachment(
  () => (pickedFile.value === null && !removed.value ? props.imagePath : null),
  { client: props.client },
)
const previewUrl = ref<string | null>(null)

watch(
  kept.localUri,
  (localUri) => {
    if (pickedFile.value === null && !removed.value) {
      previewUrl.value = localUri
    }
  },
  { immediate: true },
)

/**
 * True while the kept image's attachment ref is still resolving, so the empty
 * "絆" placeholder never flashes for a row that does have an image.
 */
const keptPending = computed(
  () =>
    pickedFile.value === null &&
    !removed.value &&
    props.imagePath !== null &&
    kept.localUri.value === null &&
    kept.error.value === null,
)

const previewLoaded = ref(false)

watch(previewUrl, () => {
  previewLoaded.value = false
})

function onPreviewRef(el: Element | null): void {
  if (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) {
    previewLoaded.value = true
  }
}

function openPicker(): void {
  fileInput.value?.click()
}

function onFilePicked(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null

  if (file === null) {
    return
  }
  pickedFile.value = file
  removed.value = false
  previewUrl.value = previewUrlForFile(file)
}

function removeImage(): void {
  pickedFile.value = null
  removed.value = true
  previewUrl.value = null
}

function save(): void {
  const trimmed = draftTitle.value.trim()

  if (trimmed.length === 0) {
    return
  }
  emit('save', { title: trimmed, imageFile: pickedFile.value, removeImage: removed.value })
}
</script>

<template>
  <ModalShell title="Edit todo" title-id="edit-todo-title" @dismiss="emit('cancel')">
    <input
      v-model="draftTitle"
      class="add-input edit-input"
      :maxlength="TITLE_MAX_LENGTH"
      :aria-label="t('add.placeholder')"
      :placeholder="t('add.placeholder')"
      @keyup.enter="save"
    />

    <div class="edit-image">
      <template v-if="previewUrl !== null">
        <Skeleton v-if="!previewLoaded" class="edit-thumb" />
        <img
          :ref="(el) => onPreviewRef(el as Element | null)"
          :src="previewUrl"
          alt=""
          class="edit-thumb"
          :style="previewLoaded ? undefined : 'display: none'"
          @load="previewLoaded = true"
          @error="previewLoaded = true"
        />
      </template>
      <Skeleton v-else-if="keptPending" class="edit-thumb" />
      <span v-else class="edit-thumb is-empty" aria-hidden="true">絆</span>
      <div class="edit-image-actions">
        <button type="button" class="icon-button is-wide" @click="openPicker">
          {{ previewUrl !== null ? 'Replace image' : 'Add image' }}
        </button>
        <button
          v-if="previewUrl !== null"
          type="button"
          class="icon-button is-wide"
          @click="removeImage"
        >
          Remove image
        </button>
      </div>
      <input ref="fileInput" type="file" accept="image/*" class="edit-file" @change="onFilePicked" />
    </div>

    <template #actions>
      <button type="button" class="modal-button is-primary" @click="save">Save</button>
      <button type="button" class="modal-button" @click="emit('cancel')">Cancel</button>
    </template>
  </ModalShell>
</template>
