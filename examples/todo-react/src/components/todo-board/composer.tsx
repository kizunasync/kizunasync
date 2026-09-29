import { Button, Input, TextField } from '@heroui/react'
import { TITLE_MAX_LENGTH } from '@kizunasync/utilities'
import { t } from '../../i18n'
import { pickImageFile } from '../../utils'

// MARK: - Composer

export interface IComposerProps {
  title: string
  setTitle: (value: string) => void
  addImageUri: string | null
  setAddImageUri: (value: string | null) => void
  onSubmit: () => void
}

/** The add-todo form: title, image picker, submit. */
export function Composer({ title, setTitle, addImageUri, setAddImageUri, onSubmit }: IComposerProps) {
  return (
    <form
      className="add-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <TextField
        className="flex-1 min-w-0"
        fullWidth
        value={title}
        aria-label="New todo"
        onChange={setTitle}
      >
        <Input maxLength={TITLE_MAX_LENGTH} placeholder={t('add.placeholder')} />
      </TextField>
      <Button
        isIconOnly
        variant={addImageUri !== null ? 'primary' : 'outline'}
        aria-label="Add image"
        onPress={() => {
          void pickImageFile().then((uri) => {
            if (uri !== null) {
              setAddImageUri(uri)
            }
          })
        }}
      >
        <span aria-hidden="true">{addImageUri !== null ? '🖼✓' : '🖼'}</span>
      </Button>
      <Button type="submit">{t('add.button')}</Button>
    </form>
  )
}
