/** Maximum content column width shared across all screens and the web tab layout. */
export const MAX_WIDTH = 680

/**
 * Ceiling for the OS font-size setting, applied to every text surface in the
 * app. The dense debug rows (op badges, log meta, queue pks) stop being legible
 * past this multiplier, since they wrap into each other rather than truncating,
 * so text keeps scaling with the device up to here and no further.
 */
export const MAX_FONT_SCALE = 1.4
