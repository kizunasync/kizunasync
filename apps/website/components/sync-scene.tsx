'use client'

import type { CSSProperties, RefObject } from 'react'
import { GLYPH, SUPABASE_GLYPH, type IFramework } from '@/lib/frameworks'
import { useSyncScene } from '@/lib/use-sync-scene'

const THREAD_PATH =
  'M36 84 C122 106 202 58 292 84 C374 106 422 102 500 78 C594 48 674 104 764 76'

const LOCAL_SQL = ['INSERT INTO', 'SELECT *', 'UPDATE SET', 'DELETE FROM'] as const
const REMOTE_SQL = ['push RPC', 'RLS check', 'verdict applied', 'checkpoint'] as const
const PROTOCOL_CHUNKS = ['outbox tx', 'mutation id', 'push RPC', 'typed verdict', 'checkpoint'] as const
const SQL_ROW_REM = 0.9
const SQL_STREAM_LENGTH = 16
const SQL_STREAM_KEYFRAMES = `
@keyframes sql-stream-loop {
  from { transform: translate3d(0, 0, 0); }
  to { transform: translate3d(0, var(--scene-sql-distance, -14.4rem), 0); }
}
`

/** Packets loop between SQLite (tinted by the framework) and Supabase. Under reduced motion both effects return early and the stylesheet stops the animations and hides the packet layer, so the scene is static. */

// MARK: - SyncScene

export function SyncScene({ framework }: { framework: IFramework }) {
  const { offline, reconnectBurst, sceneRef, packetRefs, sceneStyle } = useSyncScene(framework)

  return (
    <div
      ref={sceneRef}
      className={`sync-scene relative mx-auto mt-10 w-full max-w-[50rem] ${
        offline ? 'scene-offline' : ''
      }`}
      style={sceneStyle}
      aria-label={`Diagram: a ${framework.label} app's local SQLite syncing with your Supabase through the internet; when the connection drops, local reads and writes continue and pending changes remain in the local outbox`}
      role="img"
    >
      <style>{SQL_STREAM_KEYFRAMES}</style>
      <SceneThread />
      <ScenePacketLayer reconnectBurst={reconnectBurst} packetRefs={packetRefs} />
      <SceneNodeGrid framework={framework} offline={offline} />
    </div>
  )
}

// MARK: - SceneThread

function SceneThread() {
  return (
    <svg
      viewBox="0 0 800 120"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="scene-thread-layer px-24 pb-4"
      fill="none"
    >
      <path d={THREAD_PATH} className="scene-thread-glow" />
      <path d={THREAD_PATH} className="scene-thread-core" />
    </svg>
  )
}

// MARK: - ScenePacketLayer

function ScenePacketLayer({
  reconnectBurst,
  packetRefs,
}: {
  reconnectBurst: number
  packetRefs: RefObject<Array<HTMLSpanElement | null>>
}) {
  return (
    <div className="scene-packet-layer" aria-hidden="true">
      <span className="scene-client-chunk">
        <span>INSERT</span>
      </span>
      <span className="scene-client-chunk scene-client-chunk-late">
        <span>UPDATE</span>
      </span>
      {reconnectBurst > 0
        ? PROTOCOL_CHUNKS.map((chunk, index) => (
            <span
              key={`${reconnectBurst}-${chunk}`}
              className="scene-protocol-chunk"
              style={{ animationDelay: `${index * 95}ms` }}
            >
              {chunk}
            </span>
          ))
        : null}
      {Array.from({ length: 5 }, (_, index) => (
        <span
          key={index}
          ref={(node) => {
            packetRefs.current[index] = node
          }}
          className={`scene-packet ${index % 2 === 0 ? 'scene-packet-forward' : 'scene-packet-reverse'}`}
        />
      ))}
    </div>
  )
}

// MARK: - SceneNodeGrid

function SceneNodeGrid({ framework, offline }: { framework: IFramework; offline: boolean }) {
  return (
    <div className="scene-node-grid">
      <div className="scene-node">
        <div className="scene-card scene-local-card">
          <span className="nf scene-card-icon" aria-hidden="true">
            {GLYPH.database}
          </span>
          <SqlTape commands={LOCAL_SQL} seed={1} />
          <span className="nf scene-framework-badge" aria-hidden="true">
            {framework.glyph}
          </span>
        </div>
        <p className="scene-label">sqlite</p>
        <p className="scene-caption">writes locally</p>
      </div>

      <div className="scene-node">
        <div className="scene-card scene-hub-card">
          <span className="nf scene-cloud" aria-hidden="true">
            {offline ? GLYPH.cloudOff : GLYPH.cloud}
          </span>
          <span className="scene-status">{offline ? 'offline' : 'online'}</span>
        </div>
        <p className="scene-label">internet</p>
        <p className="scene-caption">{offline ? 'queue holds' : 'syncing'}</p>
      </div>

      <div className="scene-node">
        <div className="scene-card scene-remote-card">
          <span className="nf scene-card-icon" aria-hidden="true">
            {SUPABASE_GLYPH}
          </span>
          <SqlTape commands={REMOTE_SQL} seed={7} paused={offline} />
        </div>
        <p className="scene-label">your supabase</p>
        <p className="scene-caption">source of truth</p>
      </div>
    </div>
  )
}

/**
 * `paused` freezes the tape where it stands instead of resetting it, so the
 * server card resumes mid-stream on reconnect rather than snapping back to the
 * first row. animationPlayState is declared AFTER the `animation` shorthand
 * because the shorthand resets play-state to running.
 */
function SqlTape({
  commands,
  seed,
  paused = false,
}: {
  commands: readonly string[]
  seed: number
  paused?: boolean
}) {
  const stream = buildSqlStream(commands, seed)
  const rows = [...stream, ...stream]
  const duration = stream.length * 0.72

  return (
    <span className="scene-sql-window" aria-hidden="true">
      <span
        className="scene-sql-track"
        style={
          {
            '--scene-sql-distance': `-${stream.length * SQL_ROW_REM}rem`,
            '--scene-sql-duration': `${stream.length * 0.72}s`,
            animation: `sql-stream-loop ${duration}s linear infinite`,
            animationPlayState: paused ? 'paused' : 'running',
          } as CSSProperties
        }
      >
        {rows.map((command, index) => (
          <span className="scene-sql-row" key={`${command}-${index}`}>
            {command}
          </span>
        ))}
      </span>
    </span>
  )
}

function buildSqlStream(commands: readonly string[], seed: number) {
  return Array.from({ length: SQL_STREAM_LENGTH }, (_, index) => {
    const commandIndex = (index * 5 + seed + (index % 3)) % commands.length

    return commands[commandIndex]!
  })
}
