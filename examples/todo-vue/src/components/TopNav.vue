<script setup lang="ts">
/**
 * A centered top bar with the 絆 Kizuna Sync brand + a segmented TODO/Cache/Settings
 * control on large screens; on small screens the brand bar stays and the
 * segment moves to a full-width bottom bar (CSS media query, App.vue renders
 * both placements). Tab state is reactive in App.vue: this only emits intent
 * (router.replace tab semantics: switching never grows a back stack).
 */

import { computed, ref } from 'vue'
import type { TUuid } from 'kizunasync'
import { useOverwrites, useRejections } from 'kizunasync/vue'
import type { IKizunaSyncShim } from '../kizunasync'
import type { TTab } from '../tabs'
import { TABS } from '../tabs'
import OverwritesPanel from './OverwritesPanel.vue'
import RejectionsPanel from './RejectionsPanel.vue'

// MARK: - Segmented nav

const props = defineProps<{ active: TTab; placement: 'top' | 'bottom'; client: IKizunaSyncShim }>()
const emit = defineEmits<{ select: [tab: TTab] }>()

/**
 * App.vue mounts TopNav twice (top + bottom placements); the brand row and
 * these two badges only ever render in the top instance, so only that instance
 * needs the composables (Vue composables don't rely on call order, unlike
 * React hooks, so a prop-gated call is safe). One badge per durable journal:
 * writes the server refused, and columns another device won.
 */
const rejections = props.placement === 'top' ? useRejections({ client: props.client }) : null
const rejectionCount = computed(() => rejections?.rejections.value.length ?? 0)
const showRejections = ref(false)

const overwrites = props.placement === 'top' ? useOverwrites({ client: props.client }) : null
const overwriteCount = computed(() => overwrites?.overwrites.value.length ?? 0)
const showOverwrites = ref(false)

function dismissRejection(mutationId: TUuid): void {
  void rejections?.dismiss(mutationId)
}

function dismissOverwrite(id: number): void {
  void overwrites?.dismiss(id)
}
</script>

<template>
  <nav :class="placement === 'top' ? 'nav nav-top' : 'nav nav-bottom'">
    <div class="nav-inner">
      <div v-if="placement === 'top'" class="nav-brand">
        <span class="nav-glyph" aria-hidden="true">絆</span>
        <span class="nav-wordmark">Kizuna Sync</span>
        <button
          v-if="rejectionCount > 0"
          type="button"
          class="rejections-badge"
          aria-label="Rejections"
          @click="showRejections = true"
        >
          {{ rejectionCount }}
        </button>
        <button
          v-if="overwriteCount > 0"
          type="button"
          class="overwrites-badge"
          aria-label="Overwrites"
          @click="showOverwrites = true"
        >
          {{ overwriteCount }}
        </button>
      </div>
      <div class="segment" role="tablist">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          role="tab"
          :class="active === tab.key ? 'segment-button is-active' : 'segment-button'"
          :aria-selected="active === tab.key"
          @click="emit('select', tab.key)"
        >
          <span class="segment-glyph" aria-hidden="true">{{ tab.glyph }}</span>
          <span class="segment-label">{{ tab.label }}</span>
        </button>
      </div>
    </div>
  </nav>

  <RejectionsPanel
    v-if="placement === 'top' && showRejections"
    :rejections="rejections?.rejections.value ?? []"
    :error="rejections?.error.value ?? null"
    @dismiss="dismissRejection"
    @close="showRejections = false"
  />

  <OverwritesPanel
    v-if="placement === 'top' && showOverwrites"
    :overwrites="overwrites?.overwrites.value ?? []"
    :error="overwrites?.error.value ?? null"
    @dismiss="dismissOverwrite"
    @close="showOverwrites = false"
  />
</template>
