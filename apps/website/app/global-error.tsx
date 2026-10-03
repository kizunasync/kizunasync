'use client'

/**
 * Deliberately minimal: global-error renders INSTEAD of the root layout, so it
 * must not touch fonts, globals.css, or anything context-dependent. A minimal
 * file also sidesteps the Next 16 `/_global-error` prerender crash
 * (vercel/next.js#86178) hit when the internal fallback is generated.
 */
export default function GlobalError({ reset }: { reset: () => void }): React.ReactElement {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          margin: 0,
        }}
      >
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Something went wrong</h1>
          <button
            type="button"
            onClick={reset}
            style={{
              border: '1px solid currentColor',
              background: 'none',
              borderRadius: '6px',
              padding: '0.5rem 1rem',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
