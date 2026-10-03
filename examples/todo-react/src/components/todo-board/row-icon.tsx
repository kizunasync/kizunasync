import { ROW_ICON_PATHS, type TRowIconName } from '@kizunasync/ui'

// MARK: - Row icon

/** A Material Design row action icon drawn from the shared path data, sized by the `.row-icon` class. */
export function RowIcon({ name }: { name: TRowIconName }) {
  return (
    <svg className="row-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ROW_ICON_PATHS[name]} fill="currentColor" />
    </svg>
  )
}
