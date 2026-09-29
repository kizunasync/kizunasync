'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Table } from '@heroui/react/table'
import type { SortDescriptor } from '@heroui/react/rac'

// MARK: - Types

export interface IDataTableColumn<TRow> {
  key: string
  header: string

  render: (row: TRow) => ReactNode

  /** Tailwind classes applied to every cell in this column. */
  cellClassName?: string

  /** When set, the column header becomes a sort toggle keyed off this value. */
  sortValue?: (row: TRow) => string | number
}

interface IDataTableProps<TRow extends object> {
  label: string
  rows: TRow[]
  columns: IDataTableColumn<TRow>[]
  rowKey: (row: TRow) => string
}

// MARK: - Sorting

function compare(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }
  return String(a).localeCompare(String(b))
}

// MARK: - Component

/**
 * Interactive HeroUI table built from a column descriptor. Sorting is
 * client-side over the already-server-ordered page of rows: clicking a
 * sortable header re-orders the visible rows, so a fresh server render
 * (live refresh) always restores the canonical order.
 */
export function DataTable<TRow extends object>({
  label,
  rows,
  columns,
  rowKey,
}: IDataTableProps<TRow>) {
  // Empty column id = the unsorted initial state (server order preserved).
  const [sort, setSort] = useState<SortDescriptor>({ column: '', direction: 'ascending' })

  const sortedRows = useMemo(() => {
    const column = columns.find((candidate) => candidate.key === sort.column)

    if (column?.sortValue === undefined) {
      return rows
    }
    const accessor = column.sortValue
    const direction = sort.direction === 'descending' ? -1 : 1

    return [...rows].sort((a, b) => compare(accessor(a), accessor(b)) * direction)
  }, [rows, columns, sort])

  return (
    <Table.ScrollContainer className="max-h-[30vh] w-full overflow-y-auto">
      <Table.Content
        aria-label={label}
        selectionMode="none"
        sortDescriptor={sort}
        onSortChange={setSort}
        className="w-full"
      >
        <Table.Header className="border-site-border/60 border-b">
          {columns.map((column) => (
            <Table.Column
              key={column.key}
              id={column.key}
              isRowHeader={column.key === columns[0]?.key}
              allowsSorting={column.sortValue !== undefined}
              className="text-site-muted hover:text-site-text bg-site-surface/70 sticky top-0 z-10 px-3 py-1.5 text-left text-[0.66rem] font-medium uppercase tracking-wider backdrop-blur-sm transition-colors first:pl-4 data-[allows-sorting=true]:cursor-pointer"
            >
              {column.header}
            </Table.Column>
          ))}
        </Table.Header>
        <Table.Body items={sortedRows} renderEmptyState={() => null}>
          {(row: TRow) => (
            <Table.Row
              id={rowKey(row)}
              className="border-site-border/30 hover:bg-site-raised/40 border-b transition-colors last:border-b-0"
            >
              {columns.map((column) => (
                <Table.Cell
                  key={column.key}
                  className={`first:pl-4 ${column.cellClassName ?? 'py-1.5 pr-3 text-[0.82rem]'}`}
                >
                  {column.render(row)}
                </Table.Cell>
              ))}
            </Table.Row>
          )}
        </Table.Body>
      </Table.Content>
    </Table.ScrollContainer>
  )
}
