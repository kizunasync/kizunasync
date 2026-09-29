<script setup lang="ts">
// MARK: - SkeletonList
import Skeleton from './Skeleton.vue'

withDefaults(defineProps<{ count?: number }>(), { count: 4 })
</script>

<template>
  <ul class="list">
    <li v-for="n in count" :key="n" class="item" aria-hidden="true">
      <Skeleton width="1.3125rem" height="1.3125rem" radius="0.375rem" />
      <Skeleton class="item-thumb" />
      <Skeleton height="0.875rem" radius="0.375rem" style="flex: 1" />
      <Skeleton width="2.75rem" height="1.25rem" radius="999px" />
    </li>
  </ul>
</template>
