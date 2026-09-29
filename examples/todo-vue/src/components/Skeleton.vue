<script setup lang="ts">
// MARK: - Skeleton atom
defineProps<{ width?: string; height?: string; radius?: string }>()
</script>

<template>
  <span class="skeleton" :style="{ width, height, borderRadius: radius }" aria-hidden="true" />
</template>
