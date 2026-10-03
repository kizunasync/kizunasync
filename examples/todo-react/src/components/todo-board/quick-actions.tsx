import { Button } from '@heroui/react'
import { READ_ACTIONS, type TReadAction } from './types'

// MARK: - Quick actions

/** The read-test buttons and the bulk delete/edit-all/create-predefined actions. */
export function QuickActions({
  runReadAction,
  createPredefined,
  editAll,
  deleteAll,
}: {
  runReadAction: (action: TReadAction) => Promise<void>
  createPredefined: () => void
  editAll: () => void
  deleteAll: () => void
}) {
  return (
    <div className="actions" role="group" aria-label="Read and write tests">
      <p className="actions-title">Actions</p>
      <div className="actions-buttons">
        {READ_ACTIONS.map((action) => (
          <Button key={action.key} variant="outline" size="sm" onPress={() => void runReadAction(action)}>
            {action.label}
          </Button>
        ))}
        <Button variant="outline" size="sm" onPress={createPredefined}>
          Create predefined
        </Button>
        <Button variant="outline" size="sm" onPress={editAll}>
          Edit all
        </Button>
        <Button variant="outline" size="sm" onPress={deleteAll}>
          Delete all
        </Button>
      </div>
    </div>
  )
}
