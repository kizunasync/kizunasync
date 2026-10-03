<script setup lang="ts">
// MARK: - TodoThumb

/**
 * Resolves the row's attachment ref through the attachment port
 * (useAttachment lazy-fetches a peer's bytes on first view, the same path the
 * edit modal uses); shows a skeleton while bytes are downloading, nothing on
 * error or no image.
 */
import { toRef } from 'vue'
import type { IKizunaSync } from 'kizunasync'
import { useAttachment } from 'kizunasync/vue'
import Skeleton from './Skeleton.vue'

const props = defineProps<{ imagePath: string | null; client: IKizunaSync }>()
const { localUri, error } = useAttachment(toRef(props, 'imagePath'), { client: props.client })
</script>

<template>
  <template v-if="imagePath !== null">
    <Skeleton v-if="localUri === null && error === null" class="item-thumb" />
    <img v-else-if="localUri !== null" :src="localUri" alt="" class="item-thumb" />
  </template>
</template>
