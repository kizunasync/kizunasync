import { Fragment } from 'react'
import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { MATRIX, MATRIX_COLUMNS } from '@/components/compare/compare-matrix.data'

export function CompareMatrix() {
  return (
    <RevealOnScroll className="mt-10 overflow-x-auto">
      <table className="w-full min-w-[72rem] border-collapse text-sm">
        <thead>
          <tr className="border-site-border border-b">
            <th className="text-site-faint py-3 pr-4 text-left font-mono text-xs font-normal tracking-wide uppercase">
              Capability
            </th>
            {MATRIX_COLUMNS.map((column) => (
              <th
                key={column}
                className={`px-3 py-3 text-center font-semibold ${
                  column === 'Kizuna' ? 'text-site-accent-bright' : 'text-site-muted'
                }`}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MATRIX.map((section) => (
            <Fragment key={section.group}>
              <tr>
                <td
                  colSpan={MATRIX_COLUMNS.length + 1}
                  className="text-site-faint pt-6 pb-2 font-mono text-xs tracking-wide uppercase"
                >
                  {section.group}
                </td>
              </tr>
              {section.rows.map((row) => (
                <tr key={row.label} className="border-site-border/50 border-b">
                  <td className="py-2.5 pr-4">
                    {row.label}
                    {row.note !== undefined ? (
                      <span className="text-site-faint block text-xs leading-snug">
                        {row.note}
                      </span>
                    ) : null}
                  </td>
                  {row.cells.map((cell, index) => (
                    <td
                      key={index}
                      className={`px-3 py-2.5 text-center text-xs leading-snug ${
                        index === 0
                          ? 'bg-site-surface/40 text-site-text'
                          : 'text-site-muted'
                      }`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      <p className="text-site-faint mt-3 font-mono text-xs">
        Text cells describe different ownership boundaries; they are not equivalent feature scores.
      </p>
    </RevealOnScroll>
  )
}
