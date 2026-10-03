import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { Button } from 'heroui-native'
import { SPACING } from '@kizunasync/ui'
import { TITLE_MAX_LENGTH } from '@kizunasync/utilities'
import { EThemeColor } from '../theme'
import { sharedStyles } from '../shared-styles'
import { MAX_FONT_SCALE } from '../layout-constants'
import { PRESS_FEEDBACK } from '../press-feedback'
import { t } from '../i18n'

/**
 * Compose a todo: title, an optional device image staged for the attachment
 * port, and the add button. Submitting from the field and from the button run
 * the same handler, which guards against the resulting double-fire.
 *
 * Both buttons are heroui's. The field stays a plain TextInput: heroui's
 * TextField is a compound Root/Input/Label, and converting only one of the
 * app's three fields would leave the input styling split between two systems.
 */
export function AddRow({
  title,
  hasImage,
  onChangeTitle,
  onPickImage,
  onSubmit,
}: {
  title: string
  hasImage: boolean
  onChangeTitle: (value: string) => void
  onPickImage?: () => void
  onSubmit: () => void
}) {
  const [focused, setFocused] = useState(false)

  return (
    <View style={styles.addRow}>
      <TextInput
        style={[sharedStyles.input, focused && sharedStyles.inputFocused]}
        placeholder={t('add.placeholder')}
        placeholderTextColor={EThemeColor.faint}
        value={title}
        onChangeText={onChangeTitle}
        onSubmitEditing={onSubmit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        maxLength={TITLE_MAX_LENGTH}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        accessibilityLabel={t('add.placeholder')}
      />
      {onPickImage !== undefined ? (
        <Button
          isIconOnly
          variant={hasImage ? 'secondary' : 'outline'}
          feedbackVariant={PRESS_FEEDBACK}
          onPress={onPickImage}
          accessibilityLabel={hasImage ? 'Image attached, choose another' : 'Attach an image'}
        >
          <Button.Label>{hasImage ? '🖼✓' : '🖼'}</Button.Label>
        </Button>
      ) : null}
      <Button
        variant="primary"
        feedbackVariant={PRESS_FEEDBACK}
        onPress={onSubmit}
        accessibilityLabel={t('add.button')}
      >
        <Button.Label>{t('add.button')}</Button.Label>
      </Button>
    </View>
  )
}

const styles = StyleSheet.create({
  addRow: { flexDirection: 'row', gap: SPACING[2] },
})
