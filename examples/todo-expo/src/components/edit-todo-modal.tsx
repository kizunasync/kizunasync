import { useCallback, useState } from 'react'
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useAttachment } from '@kizunasync/react'
import { SPACING } from '@kizunasync/ui'
import { TITLE_MAX_LENGTH } from '@kizunasync/utilities'
import type { ITodo } from '../kizunasync-shim'
import { pickImageUri } from '../lib/pick-image'
import { EThemeColor } from '../theme'
import { sharedStyles } from '../shared-styles'
import { AppModal } from './app-modal'
import { Skeleton } from './skeleton'
import { t } from '../i18n'

/**
 * Edit a todo's title + image. The draft seeds from the todo when the sheet
 * opens (keyed remount via the todo id). Image edits stage a device-only intent:
 * a picked uri replaces/adds, null removes, undefined leaves it untouched. Save
 * sends a new title or a removal through editTodo (same engine path as
 * toggle/add), and a picked image through the attachment port's fromFile.
 * Cancel discards.
 */
export function EditTodoModal({
  todo,
  canAttachImages,
  onSave,
  onCancel,
}: {
  todo: ITodo | null
  canAttachImages: boolean
  onSave: (edit: { title?: string; image?: string | null }) => void
  onCancel: () => void
}) {
  if (todo === null) {
    return null
  }
  return <EditTodoModalBody key={todo.id} todo={todo} canAttachImages={canAttachImages} onSave={onSave} onCancel={onCancel} />
}

// MARK: - Pieces

function EditTodoModalBody({
  todo,
  canAttachImages,
  onSave,
  onCancel,
}: {
  todo: ITodo
  canAttachImages: boolean
  onSave: (edit: { title?: string; image?: string | null }) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(todo.title)
  const [focused, setFocused] = useState(false)
  const { image, preview, keptPending, pickImage, removeImage } = useImageDraft(todo.image_path)
  const onSavePress = useCallback(() => {
    const trimmed = title.trim()
    const edit: { title?: string; image?: string | null } = {}

    if (trimmed.length > 0 && trimmed !== todo.title) {
      edit.title = trimmed
    }
    if (image !== undefined) {
      edit.image = image
    }
    onSave(edit)
  }, [title, image, todo.title, onSave])

  return (
    <AppModal
      visible
      title="Edit todo"
      onDismiss={onCancel}
      actions={
        <>
          <Pressable style={[sharedStyles.modalButton, sharedStyles.modalButtonPrimary]} onPress={onSavePress}>
            <Text style={sharedStyles.modalButtonPrimaryText}>Save</Text>
          </Pressable>
          <Pressable style={sharedStyles.modalButton} onPress={onCancel}>
            <Text style={sharedStyles.modalButtonText}>Cancel</Text>
          </Pressable>
        </>
      }
    >
      <TextInput
        style={[sharedStyles.input, styles.editInput, focused && sharedStyles.inputFocused]}
        placeholder={t('add.placeholder')}
        placeholderTextColor={EThemeColor.faint}
        value={title}
        onChangeText={setTitle}
        onSubmitEditing={onSavePress}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        maxLength={TITLE_MAX_LENGTH}
        autoFocus
      />
      {canAttachImages ? (
        <View style={styles.editImageRow}>
          {preview !== null ? (
            <Image source={{ uri: preview }} style={styles.editThumb} />
          ) : keptPending ? (
            <Skeleton width={56} height={56} radius={10} />
          ) : (
            <View style={[styles.editThumb, styles.editThumbEmpty]}>
              <Text style={styles.editThumbGlyph}>絆</Text>
            </View>
          )}
          <View style={styles.editImageActions}>
            <Pressable style={styles.editImageButton} onPress={() => void pickImage()}>
              <Text style={styles.editImageButtonText}>{preview === null ? 'Add image' : 'Replace image'}</Text>
            </Pressable>
            {preview !== null ? (
              <Pressable style={styles.editImageButton} onPress={removeImage}>
                <Text style={sharedStyles.modalButtonDangerText}>Remove image</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </AppModal>
  )
}

// MARK: - internal

/**
 * The image draft: `undefined` keeps the row's current image, a picked device
 * uri replaces/adds it, `null` removes it. The kept image resolves to a LOCAL
 * downloaded uri through the attachment port (lazy-fetches a peer's bytes on
 * first view); only resolve it while keeping (@CONVENTIONS.md).
 */
function useImageDraft(currentImagePath: string | null): {
  image: string | null | undefined
  preview: string | null
  keptPending: boolean
  pickImage: () => Promise<void>
  removeImage: () => void
} {
  const [image, setImage] = useState<string | null | undefined>(undefined)
  const kept = useAttachment(image === undefined ? currentImagePath : null)
  const preview = image === undefined ? kept.localUri : image
  const keptPending =
    image === undefined && currentImagePath !== null && kept.localUri === null && kept.error === null
  const pickImage = useCallback(async () => {
    const uri = await pickImageUri()

    if (uri !== null) {
      setImage(uri)
    }
  }, [])
  const removeImage = useCallback(() => setImage(null), [])

  return { image, preview, keptPending, pickImage, removeImage }
}

const styles = StyleSheet.create({
  editInput: { flexGrow: 0, flexBasis: 'auto', alignSelf: 'stretch' },
  editImageRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING[3] },
  editThumb: { width: 56, height: 56, borderRadius: 10, borderCurve: 'continuous' },
  editThumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: EThemeColor.border,
    backgroundColor: EThemeColor.surface,
  },
  editThumbGlyph: { fontSize: 20, fontWeight: '700', color: EThemeColor.accent, opacity: 0.5 },
  editImageActions: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: SPACING[2] },
  editImageButton: {
    borderWidth: 1,
    borderColor: EThemeColor.border,
    borderRadius: 9,
    borderCurve: 'continuous',
    paddingHorizontal: 13,
    paddingVertical: SPACING[2],
    backgroundColor: 'transparent',
  },
  editImageButtonText: { color: EThemeColor.muted, fontSize: 13, fontWeight: '700' },
})
