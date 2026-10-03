import { useOverwrites, useRejections } from 'kizunasync/react'

/** The two durable journals a pane keeps: writes the server refused, and columns the other pane won. Both survive a reload. */
export function PaneJournal() {
  return (
    <>
      <RejectionsNotice />
      <OverwritesNotice />
    </>
  )
}

function RejectionsNotice() {
  const { rejections } = useRejections()

  if (rejections.length === 0) {
    return null
  }

  return (
    <p className="m-0 basis-full text-xs text-site-gold">
      {rejections.length === 1 ? '1 refused write' : `${String(rejections.length)} refused writes`} in this pane&apos;s
      journal · latest: {rejections[0]?.reason ?? 'unknown'}
    </p>
  )
}

function OverwritesNotice() {
  const { overwrites } = useOverwrites()

  if (overwrites.length === 0) {
    return null
  }

  return (
    <p className="m-0 basis-full text-xs text-site-muted">
      {overwrites.length === 1 ? '1 column' : `${String(overwrites.length)} columns`} the other pane won ·
      latest: {overwrites[0]?.table ?? 'unknown'}.{overwrites[0]?.column ?? 'unknown'}
    </p>
  )
}
