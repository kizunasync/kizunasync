import { useAttachment } from '@kizunasync/react'
import { SkeletonThumb } from './skeleton'

/**
 * A list-row thumbnail. Resolves the row's attachment ref through the SAME path
 * the edit modal uses (useAttachment lazy-fetches a peer's bytes on first view);
 * shows a skeleton while bytes are downloading, nothing on error or no image.
 */
export function TodoThumb({ imagePath }: { imagePath: string | null }) {
  const { localUri, error } = useAttachment(imagePath)

  if (imagePath === null) {
    return null
  }
  if (localUri === null) {
    return error === null ? <SkeletonThumb /> : null
  }
  return <img className="item-thumb" src={localUri} alt="" />
}
