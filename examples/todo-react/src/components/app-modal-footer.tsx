import type { ReactNode } from 'react'
import { Modal } from '@heroui/react'

export function AppModalFooter({ children }: { children: ReactNode }) {
  return <Modal.Footer className="flex-wrap max-[30rem]:[&>*]:w-full">{children}</Modal.Footer>
}
