<script setup lang="ts">
// MARK: - RowIcon

/**
 * A Material row-action glyph drawn from the shared `ROW_ICON_PATHS` table.
 * Imported through the /icon-paths subpath: the @kizunasync/ui barrel is not
 * resolvable by vue-tsc (see ../i18n.ts).
 */
import { ROW_ICON_PATHS, type TRowIconName } from '@kizunasync/ui/icon-paths'

defineProps<{ name: TRowIconName }>()
</script>

<template>
  <svg class="row-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path :d="ROW_ICON_PATHS[name]" fill="currentColor" />
  </svg>
</template>
