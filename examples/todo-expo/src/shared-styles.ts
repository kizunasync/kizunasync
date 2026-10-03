import { StyleSheet } from 'react-native'
import { SPACING } from '@kizunasync/ui'
import { EThemeColor } from './theme'
import { MAX_WIDTH } from './layout-constants'

/**
 * The StyleSheet entries used by more than one screen or component: the section
 * shell, the text field, and the modal chrome. The values are the home screen's
 * originals, kept in one place so the three modals and the three input sites
 * cannot drift apart. Anything used by a single component stays with it.
 */
// MARK: - Shared styles

const MODAL_CARD_RADIUS = 14
/**
 * The sheet's glass layer must cover the card's whole box, but an absolutely-
 * positioned child is laid out against the parent's PADDING box, so it bleeds
 * outward by exactly the card's padding and the card clips it back with
 * overflow: 'hidden'. That pairing is correct whichever edge the layout engine
 * measures from.
 */
const MODAL_CARD_PADDING = 18

export const sharedStyles = StyleSheet.create({
  column: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: SPACING[4] },
  sectionBlock: { gap: SPACING[2] },
  sectionTitle: {
    color: EThemeColor.muted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },

  input: {
    flex: 1,
    backgroundColor: EThemeColor.surface,
    borderWidth: 1,
    borderColor: EThemeColor.border,
    borderRadius: 11,
    paddingHorizontal: 14,
    paddingVertical: SPACING[3],
    color: EThemeColor.text,
    fontSize: 14,
  },
  inputFocused: { borderColor: EThemeColor.focusRing, backgroundColor: EThemeColor.surfaceElevated },

  modalAvoider: { flex: 1 },
  modalScrim: {
    flex: 1,
    backgroundColor: EThemeColor.scrim,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING[6],
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: EThemeColor.surfaceElevated,
    borderWidth: 1,
    borderColor: EThemeColor.border,
    borderRadius: MODAL_CARD_RADIUS,
    padding: MODAL_CARD_PADDING,
    gap: SPACING[3],
  },
  modalCardGlassHost: { backgroundColor: 'transparent', overflow: 'hidden' },
  modalCardGlass: {
    position: 'absolute',
    top: -MODAL_CARD_PADDING,
    left: -MODAL_CARD_PADDING,
    right: -MODAL_CARD_PADDING,
    bottom: -MODAL_CARD_PADDING,
    borderRadius: MODAL_CARD_RADIUS,
  },
  modalTitle: { color: EThemeColor.text, fontSize: 16, fontWeight: '700' },
  modalBody: { color: EThemeColor.muted, fontSize: 13, lineHeight: 19 },
  modalActions: { gap: SPACING[2], marginTop: SPACING[1] },
  modalButton: {
    borderWidth: 1,
    borderColor: EThemeColor.border,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  modalButtonPrimary: { backgroundColor: EThemeColor.accent, borderColor: EThemeColor.accent },
  modalButtonPrimaryText: { color: EThemeColor.accentForeground, fontSize: 14, fontWeight: '700' },
  modalButtonDangerText: { color: EThemeColor.accent, fontSize: 14, fontWeight: '700' },
  modalButtonText: { color: EThemeColor.muted, fontSize: 14, fontWeight: '600' },
})
