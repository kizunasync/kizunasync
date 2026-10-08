import type { ReactElement } from 'react'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'
import { DESCRIPTION_MAX_LINES, descriptionFontSize, titleFontSize } from './og-text'
import { TAGLINE } from './site'

// MARK: - Constants

export const OG_SIZE = { width: 1200, height: 630 }
export const OG_CONTENT_TYPE = 'image/png'

/** Brand tokens from branding/BRANDBOOK.md. */
const COLORS = {
  background: '#15141f',
  text: '#ecebf0',
  muted: '#a7a4b2',
  faint: '#76727f',
  accent: '#e5484d',
  accentBright: '#f0676b',
} as const

const PADDING = 64
const LOGO_ASPECT = 760 / 200

/** The lockup's drawing spans x=20..560 of its 760-wide canvas; showing 0..580 keeps the 20-unit margins on both sides, so centering follows the drawing. */
const LOGO_VISIBLE_ASPECT = 580 / 200
const SANS_FAMILY = 'Geist'
const MONO_FAMILY = 'Geist Mono'

const GRAIN_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='200' height='200' filter='url(#n)' opacity='.9'/></svg>"
const GRAIN_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(GRAIN_SVG).toString('base64')}`

// MARK: - Assets

function readAsset(path: string): Promise<Buffer> {
  return readFile(join(process.cwd(), path))
}

async function readLogoDataUri(): Promise<string> {
  const svg = await readAsset('public/brand/logo.svg')

  return `data:image/svg+xml;base64,${svg.toString('base64')}`
}

async function readVersion(): Promise<string> {
  const manifest = JSON.parse(await readAsset('../../packages/kizunasync/package.json').then((file) => file.toString())) as {
    version: string
  }

  return manifest.version
}

async function loadFonts() {
  const [regular, medium, semiBold, monoMedium] = await Promise.all([
    readAsset('node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf'),
    readAsset('node_modules/geist/dist/fonts/geist-sans/Geist-Medium.ttf'),
    readAsset('node_modules/geist/dist/fonts/geist-sans/Geist-SemiBold.ttf'),
    readAsset('node_modules/geist/dist/fonts/geist-mono/GeistMono-Medium.ttf'),
  ])

  return [
    { name: SANS_FAMILY, data: regular, weight: 400 as const, style: 'normal' as const },
    { name: SANS_FAMILY, data: medium, weight: 500 as const, style: 'normal' as const },
    { name: SANS_FAMILY, data: semiBold, weight: 600 as const, style: 'normal' as const },
    { name: MONO_FAMILY, data: monoMedium, weight: 500 as const, style: 'normal' as const },
  ]
}

// MARK: - Shared canvas

function Canvas({ grain = false, children }: { grain?: boolean; children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        color: COLORS.text,
        fontFamily: SANS_FAMILY,
        backgroundColor: COLORS.background,
        backgroundImage:
          'radial-gradient(844px 488px at 88% 12%, rgba(229, 72, 77, 0.28), rgba(229, 72, 77, 0) 60%), radial-gradient(656px 394px at 8% 100%, rgba(240, 103, 107, 0.10), rgba(240, 103, 107, 0) 60%)',
      }}
    >
      {grain && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            opacity: 0.07,
            backgroundImage: `url(${GRAIN_DATA_URI})`,
          }}
        />
      )}
      {children}
    </div>
  )
}

// MARK: - Page image

interface IOgImageProps {
  eyebrow?: string
  title: string
  description?: string
}

export async function renderOgImage({ eyebrow, title, description }: IOgImageProps): Promise<ImageResponse> {
  const [fonts, logo] = await Promise.all([loadFonts(), readLogoDataUri()])
  const logoHeight = 64

  return new ImageResponse(
    (
      <Canvas>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, padding: PADDING }}>
          <img src={logo} width={logoHeight * LOGO_ASPECT} height={logoHeight} alt="" />
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center', paddingTop: 40, paddingBottom: 40 }}>
            {eyebrow !== undefined && (
              <div
                style={{
                  display: 'flex',
                  marginBottom: 16,
                  fontSize: 24,
                  fontWeight: 500,
                  letterSpacing: 4,
                  textTransform: 'uppercase',
                  color: COLORS.accentBright,
                }}
              >
                {eyebrow}
              </div>
            )}
            <div
              style={{
                display: 'block',
                fontSize: titleFontSize(title),
                fontWeight: 600,
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
                lineClamp: 3,
              }}
            >
              {title}
            </div>
            {description !== undefined && (
              <div
                style={{
                  display: 'block',
                  marginTop: 20,
                  fontSize: descriptionFontSize(description),
                  lineHeight: 1.4,
                  color: COLORS.muted,
                  lineClamp: DESCRIPTION_MAX_LINES,
                }}
              >
                {description}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', fontSize: 26, fontWeight: 500, color: COLORS.muted }}>kizunasync.com</div>
        </div>
      </Canvas>
    ),
    { ...OG_SIZE, fonts },
  )
}

// MARK: - Main image

function Chip({ bold, children }: { bold?: string; children?: string }): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        borderRadius: 999,
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
        fontSize: 17,
        fontWeight: 500,
        lineHeight: 1,
        color: COLORS.muted,
      }}
    >
      {bold !== undefined && <span style={{ color: COLORS.accent, fontWeight: 600 }}>{bold}</span>}
      {children !== undefined && <span>{children}</span>}
    </div>
  )
}

export async function renderHomeOgImage(): Promise<ImageResponse> {
  const [fonts, logo, version] = await Promise.all([loadFonts(), readLogoDataUri(), readVersion()])
  const logoHeight = 180

  return new ImageResponse(
    (
      <Canvas grain>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ display: 'flex', width: logoHeight * LOGO_VISIBLE_ASPECT, height: logoHeight, overflow: 'hidden' }}>
            <img src={logo} width={logoHeight * LOGO_ASPECT} height={logoHeight} alt="" />
          </div>
          <div style={{ display: 'flex', marginTop: 36, fontSize: 64, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.02 }}>
            {`${TAGLINE}.`}
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 28,
              padding: '14px 18px',
              border: '1px solid rgba(240, 103, 107, 0.35)',
              borderRadius: 10,
              backgroundColor: 'rgba(229, 72, 77, 0.10)',
              fontFamily: MONO_FAMILY,
              fontSize: 22,
              fontWeight: 500,
              lineHeight: 1,
              color: COLORS.accentBright,
            }}
          >
            <span style={{ color: COLORS.faint, marginRight: 12 }}>$</span>
            <span>npx kizunasync</span>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
            <Chip>Supabase</Chip>
            <Chip bold="No">third-party servers</Chip>
            <Chip bold={`v${version}`} />
            <Chip bold="Apache-2.0">clients</Chip>
          </div>
        </div>
      </Canvas>
    ),
    { ...OG_SIZE, fonts },
  )
}
