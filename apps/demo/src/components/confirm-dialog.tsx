import { AlertDialog } from '@heroui/react'
import { Button } from '@/components/button'

// MARK: - Confirm dialog

/**
 * The browser's own confirm() is an OS window: it leaves the page, carries none
 * of the demo's surface, and says whatever the browser feels like saying. This
 * is the same question asked inside the demo, with a real focus trap. The
 * caller owns the open state and what confirming does.
 */
export function ConfirmDialog({
  isOpen,
  title,
  detail,
  confirmLabel,
  onOpenChange,
  onConfirm,
}: {
  isOpen: boolean
  title: string
  detail: string
  confirmLabel: string
  onOpenChange: (isOpen: boolean) => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog isOpen={isOpen} onOpenChange={onOpenChange}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container size="sm" placement="center">
          <AlertDialog.Dialog className="border border-site-border">
            <AlertDialog.Header>
              <AlertDialog.Heading className="text-sm font-bold text-site-text">{title}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="text-xs leading-relaxed text-site-muted">{detail}</AlertDialog.Body>
            <AlertDialog.Footer>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button tone="accent" type="button" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
