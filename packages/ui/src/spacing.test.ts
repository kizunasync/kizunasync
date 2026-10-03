/// <reference types="bun" />
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'
import { SPACING, RADIUS, type TSpacingStep, type TRadiusStep } from './spacing'

/**
 * Drift check against Tailwind v4's native scale (see spacing.ts). Compiles a
 * throwaway stylesheet through the real `@tailwindcss/postcss` plugin, forces
 * every step's utility class to generate via `@source inline(...)` so the
 * result does not depend on what any app happens to use, and asserts the
 * compiled px against the hand-written constant. `RADIUS.full` has no Tailwind
 * equivalent (`rounded-full` compiles to `calc(infinity * 1px)`, not a finite
 * token) and is asserted separately, by shape not value.
 */
// MARK: - Compile helper

const ROOT_FONT_SIZE_PX = 16

async function compileTailwind(classNames: string[]): Promise<string> {
  const css = `@import "tailwindcss";\n@source inline("${classNames.join(' ')}");\n`
  // Resolve `tailwindcss` from this package even when `bun test` is launched at the repo root (`from: undefined` uses process.cwd()).
  const result = await postcss([tailwindcss()]).process(css, {
    from: join(import.meta.dir, 'spacing.css'),
  })

  return result.css
}

function readThemeVarPx(css: string, name: string): number {
  const match = css.match(new RegExp(`${name}:\\s*([0-9.]+)rem;`))

  expect(match).not.toBeNull()

  return Number(match?.[1]) * ROOT_FONT_SIZE_PX
}

function readMarginTopPx(css: string, step: TSpacingStep, spacingUnitPx: number): number {
  const rule = css.match(new RegExp(`\\.mt-${step}\\s*\\{\\s*margin-top:\\s*([^;]+);`))

  expect(rule).not.toBeNull()
  const value = rule?.[1] ?? ''

  if (value === '0px') {
    return 0
  }
  if (value === 'var(--spacing)') {
    return spacingUnitPx
  }
  const multiplier = value.match(/calc\(var\(--spacing\) \* ([0-9.]+)\)/)

  expect(multiplier).not.toBeNull()

  return Number(multiplier?.[1]) * spacingUnitPx
}

// MARK: - Spacing ↔ Tailwind drift test

describe('spacing mirrors Tailwind v4\'s compiled scale', () => {
  test('every spacing step matches the compiled mt-<n> px value', async () => {
    const steps = Object.keys(SPACING) as unknown as TSpacingStep[]
    const css = await compileTailwind(steps.map((step) => `mt-${step}`))
    const spacingUnitPx = readThemeVarPx(css, '--spacing')

    for (const step of steps) {
      expect(readMarginTopPx(css, step, spacingUnitPx)).toBe(SPACING[step])
    }
  })

  test('every named radius step matches the compiled --radius-* value', async () => {
    const namedSteps = (Object.keys(RADIUS) as TRadiusStep[]).filter((step) => step !== 'full')
    const css = await compileTailwind(namedSteps.map((step) => `rounded-${step}`))

    for (const step of namedSteps) {
      expect(readThemeVarPx(css, `--radius-${step}`)).toBe(RADIUS[step])
    }
  })

  test('RADIUS.full mirrors rounded-full\'s always-maximal shape, not a finite Tailwind value', async () => {
    const css = await compileTailwind(['rounded-full'])

    expect(css).toContain('border-radius: calc(infinity * 1px);')
    expect(RADIUS.full).toBeGreaterThan(0)
  })
})
