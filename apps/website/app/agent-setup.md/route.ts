import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDocHref } from '@/lib/docs-registry'
import { SITE_URL } from '@/lib/site'

/**
 * Telnyx-style raw markdown endpoint for AI agents.
 * Canonical path: /agent-setup.md (also linked from docs + llms.txt).
 */

/**
 * Prerender at build time: the markdown lives in the monorepo `docs/` tree,
 * which exists on the build machine but is not traced into the serverless
 * bundle. A runtime read would 500 in production; the HTML docs inline their
 * content at build for the same reason.
 */
export const dynamic = 'force-static'

const DOC_REL = 'docs/getting-started/agent-setup.md'

function loadAgentSetupMarkdown(): string {
  // Prefer monorepo root (dev + turbo); fall back relative to cwd.
  const candidates = [
    join(process.cwd(), '../../', DOC_REL),
    join(process.cwd(), DOC_REL),
    join(process.cwd(), '../..', DOC_REL),
  ]

  for (const path of candidates) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
    }
  }
  // Last resort: absolute from KIZUNASYNC_REPO_ROOT
  const root = process.env.KIZUNASYNC_REPO_ROOT

  if (root) {
    return readFileSync(join(root, DOC_REL), 'utf8')
  }
  throw new Error(`agent-setup.md not found (tried ${candidates.join(', ')})`)
}

export function GET(): Response {
  let body: string

  try {
    body = loadAgentSetupMarkdown()
  } catch (error) {
    body = `# Bot / AI agent setup guide\n\nUnavailable: ${String(error)}\n\nSee ${SITE_URL}/docs/agent-setup\n`

    return new Response(body, {
      status: 500,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  const rewritten = body.replace(/\]\(((?:\.{1,2}\/)[^)\s]+)\)/g, (_match, href: string) => {
    const resolved = resolveDocHref(href, DOC_REL)

    return `](${resolved.startsWith('/') ? `${SITE_URL}${resolved}` : resolved})`
  })

  return new Response(rewritten, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-robots-tag': 'all',
    },
  })
}
