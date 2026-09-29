import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SPACING } from '@kizunasync/ui'
import { sharedStyles } from '../shared-styles'
import { GlassSurface, IS_GLASS_AVAILABLE } from './glass-surface'

/**
 * The modal card presentation shared by every dialog: a keyboard-avoiding
 * scrim, a glass card capped to the viewport (useWindowDimensions + safe-area
 * insets, SPACING[6] breathing room top and bottom), a fixed title, a
 * scrollable body, and fixed actions. This is the CARD, not the Modal:
 * `AppModal` owns the react-native Modal that presents it, and is its only
 * caller. The body scroller lives here, so no dialog nests a second one.
 */
export function ModalShell({
  title,
  children,
  actions,
  onDismiss,
}: {
  title: string
  children: ReactNode
  actions: ReactNode
  onDismiss: () => void
}) {
  const { height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const maxHeight = height - insets.top - insets.bottom - 2 * SPACING[6]

  return (
    <KeyboardAvoidingView style={sharedStyles.modalAvoider} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <Pressable style={sharedStyles.modalScrim} onPress={onDismiss}>
        <Pressable
          style={[sharedStyles.modalCard, { maxHeight }, IS_GLASS_AVAILABLE ? sharedStyles.modalCardGlassHost : null]}
        >
          <GlassSurface style={sharedStyles.modalCardGlass} />
          <Text style={sharedStyles.modalTitle}>{title}</Text>
          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
          <View style={sharedStyles.modalActions}>{actions}</View>
        </Pressable>
      </Pressable>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  scroll: { flexShrink: 1 },
})
