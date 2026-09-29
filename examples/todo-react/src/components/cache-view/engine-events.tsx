import { formatRelativeTime, summarizeEngineEvent, type TEngineEventLogEntry } from '@kizunasync/utilities'
import { ENGINE_EVENT_BADGE_CLASS } from './badges'

// MARK: - Engine events

export function EngineEvents({ engineEvents }: { engineEvents: readonly TEngineEventLogEntry[] }) {
  return (
    <>
      <p className="section-title">Engine events</p>
      {engineEvents.length === 0 ? (
        <p className="cache-empty">No events yet.</p>
      ) : (
        engineEvents
          .slice()
          .reverse()
          .map((entry, index) => (
            <div key={`${entry.at}-${index}`} className="log-row">
              <span className={ENGINE_EVENT_BADGE_CLASS[entry.event.type]}>{entry.event.type}</span>
              <span className="log-label">{summarizeEngineEvent(entry.event)}</span>
              <span className="log-meta">{formatRelativeTime(entry.at)}</span>
            </div>
          ))
      )}
    </>
  )
}
