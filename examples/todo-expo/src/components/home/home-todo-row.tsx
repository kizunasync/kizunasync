import { View } from 'react-native'
import { isTodoMine } from '@kizunasync/utilities'
import { sharedStyles } from '../../shared-styles'
import { TodoRow } from '../todo-row'
import { isEditable, ownerBadgeLabel } from '../../lib/account'
import type { ITodo } from '../../kizunasync-shim'

/**
 * One FlatList row: derives the owner/editable flags for `todo` and binds
 * them to `TodoRow`. Any visitor's row is editable on the shared board;
 * `editAnyone` lifts the local guard on a registered user's row so the
 * server-side owner check can reject the deliberate non-owner write
 * (@CONVENTIONS.md).
 */
export function HomeTodoRow({
  todo,
  myId,
  editAnyone,
  onToggle,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
}: {
  todo: ITodo
  myId: string | null
  editAnyone: boolean
  onToggle: (todo: ITodo) => void
  onEdit: (todo: ITodo) => void
  onArchive: (todo: ITodo) => void
  onRestore: (todo: ITodo) => void
  onDelete: (id: string) => void
}) {
  const mine = isTodoMine(todo, myId)
  const editable = isEditable(todo, myId, editAnyone)

  return (
    <View style={sharedStyles.column}>
      <TodoRow
        todo={todo}
        mine={mine}
        ownerLabel={ownerBadgeLabel(todo, mine)}
        editable={editable}
        onToggle={() => onToggle(todo)}
        onEdit={() => onEdit(todo)}
        onArchive={() => onArchive(todo)}
        onRestore={() => onRestore(todo)}
        onDelete={() => onDelete(todo.id)}
      />
    </View>
  )
}
