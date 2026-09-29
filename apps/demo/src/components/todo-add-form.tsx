import { useState, type FormEvent } from 'react'
import { TITLE_MAX_LENGTH } from '@kizunasync/utilities'
import { Button } from '@/components/button'
import type { TPaneId } from '@/runtime/demo-config'

interface ITodoAddFormProps {
  pane: TPaneId
  onAdd: (title: string) => void
}

export function TodoAddForm({ pane, onAdd }: ITodoAddFormProps) {
  const [title, setTitle] = useState('')

  function submit(event: FormEvent): void {
    event.preventDefault()
    onAdd(title)
    setTitle('')
  }

  return (
    <form className="flex gap-2" onSubmit={submit}>
      <input
        className="min-w-0 flex-1 rounded-lg border border-site-border bg-site-background px-2.5 py-1.5 text-sm text-site-text placeholder:text-site-faint focus-visible:border-site-accent"
        value={title}
        maxLength={TITLE_MAX_LENGTH}
        placeholder={`Add a todo in pane ${pane}`}
        aria-label={`Add a todo in pane ${pane}`}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Button tone="accent" type="submit" disabled={title.trim() === ''}>
        Add
      </Button>
    </form>
  )
}
