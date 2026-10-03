import { Composer, type IComposerProps } from './composer'
import { TodoList, type ITodoListProps } from './todo-list'

// MARK: - Todos section

/** The composer and the filtered list under the "Todos" heading: TodoBoard's third render region, grouped because both concern the same visible list. */
export function TodosSection({ composer, list }: { composer: IComposerProps; list: ITodoListProps }) {
  return (
    <div className="actions">
      <p className="actions-title">Todos</p>
      <Composer {...composer} />
      <TodoList {...list} />
    </div>
  )
}
