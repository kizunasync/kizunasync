<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    title: string
    titleId: string
    role?: 'dialog' | 'alertdialog'
  }>(),
  { role: 'dialog' },
)

const emit = defineEmits<{
  dismiss: []
}>()
</script>

<template>
  <div class="modal-scrim" role="presentation" @click="emit('dismiss')">
    <div class="modal" :role="props.role" aria-modal="true" :aria-labelledby="titleId" @click.stop>
      <h2 :id="titleId" class="modal-title">{{ title }}</h2>
      <div class="modal-scroll">
        <slot />
      </div>
      <div class="modal-actions">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>
