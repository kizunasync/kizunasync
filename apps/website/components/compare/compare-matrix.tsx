'use client'

/**
 * The /compare capability matrix. The whole table, tooltip text included, is server-rendered;
 * the "Compare with" chips are a client-only enhancement that hides columns by `data-col`.
 * The table is deliberately outside RevealOnScroll: a transformed ancestor would become the
 * containing block of the fixed tooltip panels and misplace them.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import Link from 'next/link'
import { CompareTip, useTipPinned } from '@/components/compare/compare-tip'
import { COMPARE_GROUPS, COMPARE_PRODUCTS, COMPARE_RESEARCHED_AT, ESupport, SUPPORT_LABEL, type ICompareCell, type ICompareGroup, type ICompareRow, type TProductId, type TSupport } from '@/components/compare/compare-matrix.data'

type TCompareProduct = (typeof COMPARE_PRODUCTS)[number]

// MARK: - Constants

const KIZUNA_ID = 'kizuna' satisfies TProductId
const ALTERNATIVES = COMPARE_PRODUCTS.filter((product) => product.id !== KIZUNA_ID)
const KIZUNA_TINT = 'bg-[color-mix(in_oklab,var(--color-site-accent)_8%,var(--color-site-background))]'
const STICKY_HEAD = 'xl:sticky xl:top-20'
const FIRST_COLUMN = 'bg-site-background sticky left-0 w-40 min-w-40 md:w-64 md:min-w-64'
const KIZUNA_COLUMN = `${KIZUNA_TINT} max-xl:sticky max-xl:left-40 md:max-xl:left-64 max-xl:border-r max-xl:border-r-site-border`
const RAISE_WHEN_OPEN = 'has-[[aria-expanded=true]]:z-15'
const ROW_RULE = 'border-site-border/60 border-b'
const FILTER_ROW = 'mt-4 h-9'
const FIRST_COLUMN_REM = 16
const PRODUCT_COLUMN_REM = 8

// MARK: - CompareMatrix

export function CompareMatrix() {
  const [isHydrated, setIsHydrated] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<TProductId[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const hasMoreRight = useHasMoreRight(scrollRef)
  // Once chips hide columns, the few left would otherwise stretch across the whole page.
  const tableMaxWidth = `${FIRST_COLUMN_REM + (COMPARE_PRODUCTS.length - hiddenIds.length) * PRODUCT_COLUMN_REM}rem`

  useEffect(() => setIsHydrated(true), [])

  const toggleProduct = (id: TProductId) => {
    setHiddenIds((current) => (current.includes(id) ? current.filter((hiddenId) => hiddenId !== id) : [...current, id]))
  }

  return (
    <section aria-label="Capability matrix">
      <CompareLegend />
      {isHydrated ? <CompareFilter hiddenIds={hiddenIds} onToggle={toggleProduct} /> : <div aria-hidden="true" className={FILTER_ROW} />}
      <div className="relative mt-6">
        <div ref={scrollRef} className="relative overflow-x-auto xl:overflow-visible">
          <table
            style={{ maxWidth: tableMaxWidth }}
            className="w-full border-separate border-spacing-0 text-sm"
          >
            <caption className="sr-only">
              Offline sync capabilities of Kizuna and {ALTERNATIVES.length} alternatives, researched on {COMPARE_RESEARCHED_AT}
            </caption>
            <MatrixHead hiddenIds={hiddenIds} />
            {COMPARE_GROUPS.map((group) => (
              <MatrixGroup key={group.id} group={group} hiddenIds={hiddenIds} />
            ))}
          </table>
        </div>
        <div
          aria-hidden="true"
          className={`from-site-background pointer-events-none absolute inset-y-0 right-0 w-14 bg-linear-to-l to-transparent transition-opacity duration-200 ${
            hasMoreRight ? 'opacity-100' : 'opacity-0'
          }`}
        />
      </div>
    </section>
  )
}

// MARK: - Pieces

function CompareLegend() {
  return (
    <ul aria-label="Legend" className="text-site-muted flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
      {Object.values(ESupport).map((value) => (
        <li key={value} className="flex items-center gap-2">
          <SupportMark value={value} />
          {SUPPORT_LABEL[value]}
        </li>
      ))}
    </ul>
  )
}

function CompareFilter({ hiddenIds, onToggle }: { hiddenIds: TProductId[]; onToggle: (id: TProductId) => void }) {
  const isLastShown = ALTERNATIVES.length - hiddenIds.length === 1

  return (
    <div
      data-compare-filter=""
      role="group"
      aria-labelledby="compare-filter-label"
      className={`${FILTER_ROW} flex items-center gap-1.5 overflow-x-auto pr-1 [scrollbar-width:none]`}
    >
      <span id="compare-filter-label" className="text-site-faint mr-2 shrink-0 font-mono text-xs tracking-wide whitespace-nowrap uppercase">
        Compare with
      </span>
      {ALTERNATIVES.map((product) => (
        <FilterChip
          key={product.id}
          product={product}
          isPressed={!hiddenIds.includes(product.id)}
          isLastShown={isLastShown}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}

function FilterChip({ product, isPressed, isLastShown, onToggle }: { product: TCompareProduct; isPressed: boolean; isLastShown: boolean; onToggle: (id: TProductId) => void }) {
  return (
    <button
      type="button"
      aria-pressed={isPressed}
      disabled={isPressed && isLastShown}
      onClick={() => onToggle(product.id)}
      className={`shrink-0 cursor-pointer rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors disabled:cursor-not-allowed ${
        isPressed
          ? 'border-site-accent-dim bg-site-accent/10 text-site-text'
          : 'border-site-border text-site-muted hover:text-site-text'
      }`}
    >
      {productShortName(product)}
    </button>
  )
}

function MatrixHead({ hiddenIds }: { hiddenIds: TProductId[] }) {
  return (
    <thead>
      <tr>
        <th
          scope="col"
          className={`${FIRST_COLUMN} ${STICKY_HEAD} border-site-border z-30 border-b pt-3 pb-2.5 pr-3 text-left align-bottom font-mono text-xs font-normal tracking-wide text-site-faint uppercase`}
        >
          Capability
        </th>
        {COMPARE_PRODUCTS.map((product) => (
          <th
            key={product.id}
            scope="col"
            data-col={product.id}
            className={`${STICKY_HEAD} border-site-border border-b border-t-2 px-2 pt-3 pb-2.5 text-center align-bottom text-xs font-semibold whitespace-nowrap ${headClass(product.id, hiddenIds)}`}
          >
            {productShortName(product)}
          </th>
        ))}
      </tr>
    </thead>
  )
}

function MatrixGroup({ group, hiddenIds }: { group: ICompareGroup; hiddenIds: TProductId[] }) {
  return (
    <tbody>
      <tr>
        <th scope="rowgroup" colSpan={COMPARE_PRODUCTS.length + 1 - hiddenIds.length} className="pt-8 pb-2.5 text-left font-normal">
          <div className="text-site-faint sticky left-0 w-max font-mono text-xs tracking-wide uppercase">{group.label}</div>
        </th>
      </tr>
      {group.rows.map((row) => (
        <MatrixRow key={row.id} row={row} hiddenIds={hiddenIds} />
      ))}
    </tbody>
  )
}

function MatrixRow({ row, hiddenIds }: { row: ICompareRow; hiddenIds: TProductId[] }) {
  return (
    <tr>
      <th scope="row" className={`${FIRST_COLUMN} ${ROW_RULE} ${RAISE_WHEN_OPEN} z-10 py-1.5 pr-3 text-left align-middle font-normal`}>
        <CompareTip id={`tip-${row.id}`} label={<CapabilityLabel label={row.label} />}>
          {row.definition}
        </CompareTip>
      </th>
      {COMPARE_PRODUCTS.map((product) => (
        <td
          key={product.id}
          data-col={product.id}
          className={`${ROW_RULE} px-1 py-1 text-center align-middle ${bodyClass(product.id, hiddenIds)}`}
        >
          <CompareTip id={`tip-${row.id}-${product.id}`} label={<MarkTrigger value={row.cells[product.id].value} />}>
            <CellTip product={product} row={row} cell={row.cells[product.id]} />
          </CompareTip>
        </td>
      ))}
    </tr>
  )
}

function CapabilityLabel({ label }: { label: string }) {
  return (
    <span className="text-site-text decoration-site-faint group-hover:decoration-site-accent group-aria-expanded:decoration-site-accent block py-1 text-[13px] leading-snug underline decoration-dotted underline-offset-4 transition-colors md:text-sm">
      {label}
    </span>
  )
}

function MarkTrigger({ value }: { value: TSupport }) {
  return (
    <span className="group-hover:bg-site-raised group-aria-expanded:bg-site-raised flex size-9 items-center justify-center rounded-md transition-colors">
      <SupportMark value={value} />
      <span className="sr-only">{SUPPORT_LABEL[value]}</span>
    </span>
  )
}

function CellTip({ product, row, cell }: { product: TCompareProduct; row: ICompareRow; cell: ICompareCell }) {
  return (
    <>
      <div className="border-site-border mb-2 border-b pb-2">
        <p className="text-site-faint font-mono text-[10px] tracking-wide uppercase">{product.name}</p>
        <p className="mt-0.5 font-semibold">{row.label}</p>
      </div>
      <p>{cell.detail}</p>
      {cell.caveat === undefined ? null : <p className="text-site-muted mt-1.5">{cell.caveat}</p>}
      {cell.sourceUrl === undefined ? null : <SourceLink href={cell.sourceUrl} />}
    </>
  )
}

function SourceLink({ href }: { href: string }) {
  const tabIndex = useTipPinned() ? 0 : -1
  const className = 'text-site-accent-bright mt-2 inline-block font-medium hover:underline'

  if (href.startsWith('/')) {
    return (
      <Link href={href} tabIndex={tabIndex} className={className}>
        Source
      </Link>
    )
  }

  return (
    <a href={href} tabIndex={tabIndex} target="_blank" rel="noopener noreferrer" className={className}>
      Source
    </a>
  )
}

function SupportMark({ value }: { value: TSupport }): ReactNode {
  switch (value) {
    case ESupport.yes:
      return <MarkGlyph className="text-site-accent" path="M5 12.5l4.5 4.5L19 7.5" />
    case ESupport.partial:
      return <MarkGlyph className="text-site-partial" path="M4.5 14.5C6.5 10.5 9.5 10 12 12s5.5 2.5 7.5-2.5" />
    case ESupport.no:
      return <MarkGlyph className="text-site-muted" path="M7 7l10 10M17 7 7 17" />
    case ESupport.unknown:
      return <MarkGlyph className="text-site-muted opacity-70" path="M8 12h8" />
  }
}

function MarkGlyph({ className, path }: { className: string; path: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`size-[17px] ${className}`} fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  )
}

// MARK: - Internal

const useHasMoreRight = (scrollRef: RefObject<HTMLDivElement | null>): boolean => {
  const [hasMoreRight, setHasMoreRight] = useState(false)

  useEffect(() => {
    const scroller = scrollRef.current

    if (scroller === null) {
      return
    }

    const measure = () => setHasMoreRight(scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1)
    const observer = new ResizeObserver(measure)

    measure()
    observer.observe(scroller)

    if (scroller.firstElementChild !== null) {
      observer.observe(scroller.firstElementChild)
    }
    scroller.addEventListener('scroll', measure, { passive: true })

    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', measure)
    }
  }, [scrollRef])

  return hasMoreRight
}

function productShortName(product: TCompareProduct): string {
  return 'shortName' in product ? product.shortName : product.name
}

function headClass(id: TProductId, hiddenIds: TProductId[]): string {
  if (hiddenIds.includes(id)) {
    return 'hidden'
  }

  if (id === KIZUNA_ID) {
    return `${KIZUNA_COLUMN} border-t-site-accent text-site-accent-bright z-30`
  }

  return 'bg-site-background text-site-muted z-20 border-t-transparent'
}

function bodyClass(id: TProductId, hiddenIds: TProductId[]): string {
  if (hiddenIds.includes(id)) {
    return 'hidden'
  }

  return id === KIZUNA_ID ? `${KIZUNA_COLUMN} ${RAISE_WHEN_OPEN} z-10` : ''
}
