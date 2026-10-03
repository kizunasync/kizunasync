import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DOC_GROUPS, DOCS, docsForNav, resolveDocHref } from './docs-registry'
import { headingIds } from './heading-ids'
import { FIXED_REFERENCE_SLUGS, REFERENCE_LIBRARIES, REFERENCE_PAGE_KINDS, REFERENCE_SECTIONS, SHARED_REFERENCE_SLUGS, findReferenceLibrary, findReferencePage, referenceHref, referencePageFile } from './reference-registry'
import { adjacentDocs, getDocsNavEntries, parseDocSource, readLibraryVersion } from './docs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const toRepoPath = (path: string): string => relative(REPO_ROOT, path).split(sep).join('/')

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      return markdownFiles(path)
    }
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  })
}

interface IMarkdownLink {
  href: string
  line: number
}

function markdownLinks(source: string): IMarkdownLink[] {
  const links: IMarkdownLink[] = []
  let inFence = false

  for (const [index, line] of source.split('\n').entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      continue
    }

    const pattern = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g

    for (const match of line.matchAll(pattern)) {
      const href = match[1] ?? match[2]

      if (href !== undefined && href.length > 0) {
        links.push({ href, line: index + 1 })
      }
    }
  }
  return links
}

function localPathFromHref(href: string): string | null {
  if (href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(href)) {
    return null
  }
  const withoutFragment = href.split('#', 1)[0] ?? ''
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? ''

  if (withoutQuery.length === 0) {
    return null
  }
  try {
    return decodeURIComponent(withoutQuery)
  } catch {
    return withoutQuery
  }
}

function markdownAnchors(source: string): Set<string> {
  const body = parseDocSource(source).content
  const anchors = new Set(headingIds(body).map((heading) => heading.id))
  let inFence = false

  for (const line of source.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      continue
    }

    for (const explicit of line.matchAll(/<(?:a|span)\s+[^>]*\bid=["']([^"']+)["'][^>]*>/gi)) {
      if (explicit[1] !== undefined) {
        anchors.add(explicit[1])
      }
    }
  }
  return anchors
}

function decodedFragment(href: string): string | null {
  const marker = href.indexOf('#')

  if (marker < 0 || marker === href.length - 1) {
    return null
  }
  const fragment = href.slice(marker + 1)

  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}

describe('parseDocSource', () => {
  test('extracts and normalizes the frontmatter status', () => {
    assert.deepEqual(parseDocSource('---\nstatus: Beta\n---\n# Title\n'), {
      content: '# Title\n',
      status: 'beta',
    })
  })

  test('keeps documents without frontmatter unchanged', () => {
    assert.deepEqual(parseDocSource('# Title\n'), { content: '# Title\n' })
  })
})
describe('public documentation registry', () => {
  test('uses unique, valid entries whose files exist', () => {
    assert.equal(new Set(DOCS.map((doc) => doc.slug)).size, DOCS.length, 'duplicate documentation slug')
    assert.equal(new Set(DOCS.map((doc) => doc.file)).size, DOCS.length, 'duplicate documentation file')

    for (const doc of DOCS) {
      assert.match(doc.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `invalid slug: ${doc.slug}`)
      assert.ok(DOC_GROUPS.some((group) => group === doc.group), `unknown group for ${doc.file}: ${doc.group}`)
      assert.ok(doc.title.trim().length > 0, `missing title: ${doc.file}`)
      assert.ok(doc.description.trim().length > 0, `missing description: ${doc.file}`)
      assert.ok(existsSync(join(REPO_ROOT, doc.file)), `registered file does not exist: ${doc.file}`)
      assert.ok(
        doc.file === 'GOVERNANCE.md' || doc.file.startsWith('docs/'),
        `registered file is outside the public documentation boundary: ${doc.file}`,
      )
    }
  })

  test('registers every public Markdown file exactly once', () => {
    const publicMarkdown = markdownFiles(join(REPO_ROOT, 'docs')).map(toRepoPath)

    publicMarkdown.push('GOVERNANCE.md')

    const registered = [
      ...DOCS.map((doc) => doc.file),
      ...REFERENCE_LIBRARIES.flatMap((library) =>
        library.pages.map((page) => referencePageFile(library.id, page.slug)),
      ),
    ]

    assert.deepEqual(
      [...registered].sort(),
      publicMarkdown.sort(),
      'docs-registry plus reference trees must be a bijection with public Markdown under docs/ plus GOVERNANCE.md',
    )
  })

  test('reader-run kizunasync commands never use the cargo debug binary', () => {
    const banned = [/target\/debug\/kizunasync\b/, /cargo build -p kizunasync-cli/]
    const files = [...DOCS.map((doc) => doc.file), 'README.md']

    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')

      for (const pattern of banned) {
        assert.equal(
          pattern.test(source),
          false,
          `${file} must invoke kizunasync through npx / pnpm dlx / yarn dlx / bunx, not ${pattern}`,
        )
      }
    }
  })

  test('pages that tell the reader to run bun install also link the Bun install guide', () => {
    const files = [...DOCS.map((doc) => doc.file), 'README.md']

    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')

      if (!/\bbun install\b/.test(source)) {
        continue
      }
      assert.match(
        source,
        /https:\/\/bun\.sh\/docs\/installation/,
        `${file} tells the reader to run bun install but does not link https://bun.sh/docs/installation`,
      )
    }
  })

  test('shared how-to framework tabs include Swift and Kotlin', () => {
    const files = [
      'docs/sync/offline-writes.md',
      'docs/attachments/media-and-attachments.md',
      'docs/sync/validate-writes.md',
    ]

    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')

      assert.match(source, /tab=Swift\b/, `${file} must include a Swift framework tab`)
      assert.match(source, /tab=Kotlin\b/, `${file} must include a Kotlin framework tab`)
    }
  })

  test('uses the product-area documentation groups', () => {
    assert.deepEqual([...DOC_GROUPS], ['Getting started', 'Sync', 'Attachments', 'CLI & provisioning', 'Testing & operations', 'Reference', 'Resources'])
    assert.ok(DOCS.some((doc) => doc.slug === 'playground'))
    assert.ok(DOCS.some((doc) => doc.slug === 'contribute'))
  })

  test('agent-setup is registered but hidden from reader nav', () => {
    const agent = DOCS.find((doc) => doc.slug === 'agent-setup')

    assert.ok(agent !== undefined)
    assert.equal(agent?.navHidden, true)
    assert.ok(!docsForNav(DOCS).some((doc) => doc.slug === 'agent-setup'))
    assert.ok(!getDocsNavEntries().some((doc) => doc.slug === 'agent-setup'))
    assert.equal(adjacentDocs('how-kizuna-works').next?.slug, 'playground')
  })

  test('page title, H1, and registry title are the same string', () => {
    const allowedDocTypes = new Set(['tutorial', 'how-to', 'concept', 'reference'])

    for (const doc of DOCS) {
      const source = readFileSync(join(REPO_ROOT, doc.file), 'utf8')
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)

      assert.ok(match !== null, `missing frontmatter: ${doc.file}`)
      const frontmatter = match[1] ?? ''
      const rawTitle = /^title:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim()

      assert.ok(rawTitle !== undefined, `missing YAML title: ${doc.file}`)
      const yamlTitle = rawTitle.replace(/^["']|["']$/g, '')

      assert.equal(yamlTitle, doc.title, `YAML title must match registry title: ${doc.file}`)
      const body = source.slice(match[0].length)
      const heading = /^# (.+)$/m.exec(body)?.[1]

      assert.equal(heading, doc.title, `H1 must match registry title: ${doc.file}`)
      const docType = /^docType:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim()

      assert.ok(
        docType !== undefined && allowedDocTypes.has(docType),
        `docType must be tutorial, how-to, concept, or reference: ${doc.file} (${docType})`,
      )
    }
  })

  test('closing headings follow the group and docType contract', () => {
    for (const doc of DOCS) {
      if (doc.file === 'GOVERNANCE.md') {
        continue
      }
      const source = readFileSync(join(REPO_ROOT, doc.file), 'utf8')
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
      const docType = /^docType:\s*(.+)$/m.exec(match?.[1] ?? '')?.[1]?.trim()
      const expected =
        doc.group === 'Getting started' || docType === 'how-to' || docType === 'tutorial'
          ? '## Next steps'
          : doc.group === 'Reference'
            ? '## Related reference'
            : '## Related pages'
      const closings = [...source.matchAll(/^## (Next steps|Related pages|Related reference)\s*$/gm)]

      assert.ok(closings.length > 0, `missing closing heading: ${doc.file}`)
      const last = closings[closings.length - 1]

      assert.equal(`## ${last?.[1]}`, expected, `wrong closing heading: ${doc.file}`)
    }
  })

  test('registry includes repository layout and native API pages', () => {
    const slugs = new Set(DOCS.map((doc) => doc.slug))

    assert.ok(slugs.has('repository-layout'), 'docs-registry must include repository-layout')
    assert.ok(REFERENCE_LIBRARIES.some((library) => library.id === 'swift'), 'reference registry must include swift')
  })

  test('hero frameworks include Swift, Kotlin, and Vanilla', () => {
    const source = readFileSync(join(REPO_ROOT, 'apps/website/lib/frameworks.ts'), 'utf8')

    assert.match(source, /label: 'Swift'/)
    assert.match(source, /label: 'Kotlin'/)
    assert.match(source, /label: 'Vanilla'/)
  })

  test('marketing copy never tells readers to build kizunasync-cli', () => {
    const files = ['apps/website/app/page.tsx', 'apps/website/app/llms.txt/route.ts']

    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')

      assert.equal(
        /Build kizunasync-cli|cargo build -p kizunasync-cli/.test(source),
        false,
        `${file} must invoke kizunasync through package-manager runners`,
      )
    }
  })

  test('expo guide documents UniFFI and the React Native module', () => {
    const source = readFileSync(join(REPO_ROOT, 'docs/getting-started/expo.md'), 'utf8')

    assert.match(source, /React Native module inside `kizunasync`/)
    assert.match(source, /UniFFI/)
  })

  test('vite guide states the Rust-in-worker browser engine', () => {
    const source = readFileSync(join(REPO_ROOT, 'docs/getting-started/vite.md'), 'utf8')

    assert.match(source, /Rust engine/)
    assert.match(source, /worker/)
  })
})

describe('public documentation links', () => {
  test('resolve to repository targets and never expose maintainer plans', () => {
    const docsByFile = new Map(DOCS.map((doc) => [doc.file, doc]))
    const docsBySlug = new Map(DOCS.map((doc) => [doc.slug, doc]))
    const linkSources = [
      ...DOCS.map((doc) => ({ file: doc.file, renderedInSite: true })),
      ...REFERENCE_LIBRARIES.flatMap((library) =>
        library.pages.map((page) => ({
          file: referencePageFile(library.id, page.slug),
          renderedInSite: true,
        })),
      ),
      { file: 'README.md', renderedInSite: false },
    ]

    for (const sourceDoc of linkSources) {
      const sourcePath = join(REPO_ROOT, sourceDoc.file)
      const source = readFileSync(sourcePath, 'utf8')

      for (const link of markdownLinks(source)) {
        const context = `${sourceDoc.file}:${link.line} -> ${link.href}`

        if (link.href.startsWith('/docs/images/')) {
          assert.ok(
            existsSync(join(REPO_ROOT, 'apps/website/public', link.href.slice(1))),
            `missing public documentation image: ${context}`,
          )
          continue
        }
        if (link.href.startsWith('/docs/')) {
          const route = link.href.split(/[?#]/, 1)[0] ?? ''
          const slugPath = route.slice('/docs/'.length)
          const referenceMatch = /^reference\/([a-z]+)\/([a-z0-9-]+)$/.exec(slugPath)

          if (referenceMatch !== null) {
            const found = findReferencePage(referenceMatch[1] ?? '', referenceMatch[2] ?? '')

            assert.ok(found !== undefined, `unknown public documentation route: ${context}`)
            const fragment = decodedFragment(link.href)

            if (fragment !== null && found !== undefined) {
              const file = referencePageFile(found.library.id, found.page.slug)

              assert.ok(
                markdownAnchors(readFileSync(join(REPO_ROOT, file), 'utf8')).has(fragment),
                `missing public documentation route anchor: ${context}`,
              )
            }
            continue
          }
          const targetDoc = docsBySlug.get(slugPath)

          assert.ok(targetDoc !== undefined, `unknown public documentation route: ${context}`)
          const fragment = decodedFragment(link.href)

          if (fragment !== null && targetDoc !== undefined) {
            assert.ok(
              markdownAnchors(readFileSync(join(REPO_ROOT, targetDoc.file), 'utf8')).has(fragment),
              `missing public documentation route anchor: ${context}`,
            )
          }
          continue
        }

        const localPath = localPathFromHref(link.href)

        if (localPath === null) {
          continue
        }

        const targetPath = resolve(dirname(sourcePath), localPath)
        const targetFile = toRepoPath(targetPath)

        assert.ok(existsSync(targetPath), `broken local documentation link: ${context}`)

        const targetDoc = docsByFile.get(targetFile)
        const referenceRoute = /^docs\/reference\/([a-z]+)\/([a-z0-9-]+)\.md$/.exec(targetFile)

        if (sourceDoc.renderedInSite && (targetDoc !== undefined || referenceRoute !== null)) {
          const resolved = resolveDocHref(link.href, sourceDoc.file)
          const anchor = link.href.includes('#') ? `#${link.href.split('#').slice(1).join('#')}` : ''
          const expected =
            targetDoc !== undefined
              ? `/docs/${targetDoc.slug}${anchor}`
              : `/docs/reference/${referenceRoute?.[1]}/${referenceRoute?.[2]}${anchor}`

          assert.equal(
            resolved,
            expected,
            `registered documentation link does not resolve in-site: ${context}`,
          )
        }
      }
    }
  })
})


describe('client reference registry', () => {
  const METHOD_H2_ORDER = ['Examples', 'Parameters', 'Returns', 'Errors', 'Notes', 'Related reference']
  const INITIALIZING_H2_ORDER = [
    'Examples',
    'Parameters',
    'Returns',
    'Errors',
    'Notes',
    'Next steps',
    'Related reference',
  ]
  const INTRODUCTION_H2S = ['Version', 'What this reference covers', 'What Supabase covers', 'Related reference']

  function h2s(markdown: string): string[] {
    const out: string[] = []
    let inFence = false

    for (const line of markdown.split('\n')) {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence
        continue
      }
      const match = inFence ? null : /^## (.+?)\s*$/.exec(line)

      if (match?.[1] !== undefined) {
        out.push(match[1])
      }
    }
    return out
  }

  function proseLines(markdown: string): Array<[number, string]> {
    const lines: Array<[number, string]> = []
    let inFence = false

    for (const [index, line] of markdown.split('\n').entries()) {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence
        continue
      }
      if (!inFence) {
        lines.push([index + 1, line])
      }
    }
    return lines
  }

  function frontmatterOf(source: string): { frontmatter: string; body: string } {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)

    assert.ok(match !== null, 'missing frontmatter')

    return { frontmatter: match[1] ?? '', body: source.slice(match[0].length) }
  }

  test('libraries are unique, start with the fixed trio, and use valid slugs, kinds, and sections', () => {
    assert.equal(new Set(REFERENCE_LIBRARIES.map((library) => library.id)).size, REFERENCE_LIBRARIES.length)

    for (const library of REFERENCE_LIBRARIES) {
      assert.match(library.id, /^[a-z]+$/)
      assert.deepEqual(library.pages.slice(0, 3).map((page) => page.slug), [...FIXED_REFERENCE_SLUGS], library.id)
      assert.equal(new Set(library.pages.map((page) => page.slug)).size, library.pages.length, `duplicate slug in ${library.id}`)

      for (const page of library.pages) {
        assert.match(page.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${library.id}/${page.slug}`)
        assert.ok((REFERENCE_PAGE_KINDS as readonly string[]).includes(page.kind), `${library.id}/${page.slug} kind`)
        assert.ok(page.section === undefined || (REFERENCE_SECTIONS as readonly string[]).includes(page.section), `${library.id}/${page.slug} section`)
        assert.ok(!/[`()]/.test(page.title), `title is a task phrase, not a call: ${library.id}/${page.slug}`)
        assert.ok(existsSync(join(REPO_ROOT, referencePageFile(library.id, page.slug))), `missing ${referencePageFile(library.id, page.slug)}`)
      }
    }
  })

  test('swift and kotlin trees mirror each other and share the common slugs with javascript', () => {
    const byId = new Map(REFERENCE_LIBRARIES.map((library) => [library.id, library]))
    const swift = byId.get('swift')
    const kotlin = byId.get('kotlin')
    const javascript = byId.get('javascript')

    assert.ok(swift !== undefined && kotlin !== undefined && javascript !== undefined)
    assert.deepEqual(kotlin!.pages, swift!.pages)

    for (const library of [swift!, kotlin!, javascript!]) {
      const slugs = new Set(library.pages.map((page) => page.slug))

      for (const slug of SHARED_REFERENCE_SLUGS) {
        assert.ok(slugs.has(slug), `${library.id} is missing shared slug ${slug}`)
      }
    }
  })

  test('reference pages carry the reference frontmatter and the library-prefixed H1', () => {
    for (const library of REFERENCE_LIBRARIES) {
      for (const page of library.pages) {
        const file = referencePageFile(library.id, page.slug)
        const { frontmatter, body } = frontmatterOf(readFileSync(join(REPO_ROOT, file), 'utf8'))
        const yamlTitle = /^title:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, '')

        assert.equal(yamlTitle, page.title, file)
        assert.equal(/^# (.+)$/m.exec(body)?.[1], `${library.title}: ${page.title}`, `H1 must be "<Library>: <title>": ${file}`)
        assert.equal(/^docType:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim(), 'reference', file)
        assert.equal(/^library:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim(), library.id, file)
        assert.equal(/^pageKind:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim(), page.kind, file)
        assert.ok(/^description:\s*\S/m.test(frontmatter), `missing description: ${file}`)
        const headings = h2s(body)

        assert.equal(headings.at(-1), 'Related reference', `last H2 must be Related reference: ${file}`)
        assert.ok(!headings.some((heading) => /^(Introduction|Overview)$/.test(heading)), file)
      }
    }
  })

  test('method pages open with Examples in the library language and use the fixed H2 order', () => {
    for (const library of REFERENCE_LIBRARIES) {
      for (const page of library.pages.filter((entry) => entry.kind === 'method' || entry.kind === 'initializing')) {
        const file = referencePageFile(library.id, page.slug)
        const { body } = frontmatterOf(readFileSync(join(REPO_ROOT, file), 'utf8'))
        const headings = h2s(body)

        assert.equal(headings[0], 'Examples', `first H2 must be Examples: ${file}`)
        const order = page.kind === 'initializing' ? INITIALIZING_H2_ORDER : METHOD_H2_ORDER
        const positions = headings.map((heading) => order.indexOf(heading))

        assert.ok(positions.every((index) => index >= 0), `unknown H2 on a method page: ${file} (${headings.join(', ')})`)
        assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `H2 order: ${file}`)
        const fencePattern = new RegExp('^```(' + library.codeLangs.join('|') + ')\\b', 'm')

        assert.match(body, fencePattern, `needs a fenced example in ${library.codeLangs.join('/')}: ${file}`)
      }
    }
  })

  test('initializing pages carry Next steps immediately before Related reference', () => {
    for (const library of REFERENCE_LIBRARIES) {
      for (const page of library.pages.filter((entry) => entry.kind === 'initializing')) {
        const file = referencePageFile(library.id, page.slug)
        const headings = h2s(frontmatterOf(readFileSync(join(REPO_ROOT, file), 'utf8')).body)
        const related = headings.indexOf('Related reference')

        assert.ok(related > 0 && headings[related - 1] === 'Next steps', `Next steps must come right before Related reference: ${file} (${headings.join(', ')})`)
      }
    }
  })

  test('introduction pages state the version and defer to Supabase', () => {
    for (const library of REFERENCE_LIBRARIES) {
      const file = referencePageFile(library.id, 'introduction')
      const { body } = frontmatterOf(readFileSync(join(REPO_ROOT, file), 'utf8'))

      assert.deepEqual(h2s(body), INTRODUCTION_H2S, file)
      const version = readLibraryVersion(library.versionSource)

      assert.ok(body.includes(`\`${version}\``), `## Version must contain \`${version}\`: ${file}`)
      const deferral = body.split('## What Supabase covers')[1]?.split('## Related reference')[0] ?? ''
      const supabaseLinks = deferral.match(/https:\/\/supabase\.com\/docs\//g) ?? []

      assert.ok(supabaseLinks.length >= 3, `deferral table needs Supabase links: ${file}`)
    }
  })

  test('installing pages show public registry coordinates and no publication disclaimer', () => {
    const coordinate: Record<string, RegExp> = {
      swift: /github\.com\/kizunasync\/kizunasync-swift/,
      kotlin: /com\.kizunasync:kizunasync/,
    }

    for (const library of REFERENCE_LIBRARIES) {
      const file = referencePageFile(library.id, 'installing')
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')

      assert.doesNotMatch(
        source,
        /workspace:\*|\.package\(path:|crates\/kizunasync-ffi\/bindings/,
        `${file} must not show a workspace or path install`,
      )
      assert.match(source, coordinate[library.id] ?? /npm install kizunasync/, `${file} shows the public registry coordinate`)
      assert.doesNotMatch(
        source,
        /unpublished|not published|nothing is published|is published nowhere|no (?:\w+ ){1,2}(?:is|are) published|do(es)? not resolve|first public tag|release pending/i,
        `${file} must not carry a publication disclaimer`,
      )

      if (library.id === 'swift' || library.id === 'kotlin') {
        const version = readLibraryVersion(library.versionSource)

        assert.ok(source.includes(version), `${file} must pin workspace version ${version}`)
      }
    }
  })

  test('sections follow the global order and twin pages link each other', () => {
    for (const library of REFERENCE_LIBRARIES) {
      let last = -1

      for (const page of library.pages) {
        if (page.section === undefined) {
          continue
        }
        const index = REFERENCE_SECTIONS.indexOf(page.section)

        assert.ok(index >= last, `sections out of global order at ${library.id}/${page.slug}`)
        last = index
      }
    }
    const twins = ['swift', 'kotlin', 'javascript']

    for (const libraryId of twins) {
      for (const slug of SHARED_REFERENCE_SLUGS) {
        const source = readFileSync(join(REPO_ROOT, referencePageFile(libraryId, slug)), 'utf8')
        const related = source.split('## Related reference')[1] ?? ''

        for (const twin of twins.filter((id) => id !== libraryId)) {
          assert.ok(related.includes(`../${twin}/${slug}.md`), `${libraryId}/${slug} must link its ${twin} twin`)
        }
      }
    }
  })

  test('reference prose keeps one example domain, one parameter table shape, and the lintable style rules', () => {
    const filler = /\b(just|simply|easy|easily|please|let['’]s|actually|obviously)\b/i
    const aiLexicon =
      /\b(delve|tapestry|leverag(?:e|es|ed|ing)|robust(?:ly|ness)?|seamless(?:ly)?|groundbreaking|cutting-edge|pivotal|multifaceted|foster(?:s|ed|ing)?|harness(?:es|ed|ing)? (?:the|its|your|our)|unlock(?:s|ed|ing)?|unleash(?:es|ed|ing)?|testament|furthermore|moreover|additionally|important to note|fast-paced|at the end of the day|not only\b.{0,60}\bbut|it['’]s not just|isn['’]t just|thrilled|game-changer|revolutioni[sz]e|best-in-class|to be honest)\b/i

    for (const library of REFERENCE_LIBRARIES) {
      for (const page of library.pages) {
        const file = referencePageFile(library.id, page.slug)
        const { body } = frontmatterOf(readFileSync(join(REPO_ROOT, file), 'utf8'))

        for (const [line, textLine] of proseLines(body)) {
          const cells = /^\s*\|/.test(textLine)
            ? textLine.split('|').map((cell) => cell.trim()).filter((cell) => cell !== '—').join(' | ')
            : textLine

          assert.ok(!/—/.test(cells), `em dash in prose at ${file}:${line}`)
          assert.ok(!filler.test(textLine), `banned filler at ${file}:${line}`)
          assert.ok(!aiLexicon.test(textLine), `AI lexicon at ${file}:${line}`)
          assert.ok(!/\[here\]\(/i.test(textLine), `link text "here" at ${file}:${line}`)
        }
        if (body.includes('## Parameters')) {
          assert.ok(body.includes('| Name | Type | Required | Description |'), `parameter table header: ${file}`)
        }
        if (page.section === 'Database') {
          assert.ok(/\btodos\b/.test(body), `Database pages use the todos example domain: ${file}`)
        }
        if (page.kind === 'introduction') {
          const version = body.split('## Version')[1]?.split('## What this reference covers')[0] ?? ''

          assert.match(version, /\(Alpha\)/, `${file} version line names Alpha`)
          assert.ok(version.includes('[Installing](./installing.md)'), `${file} version line links Installing`)
        }
      }
    }
  })

  test('resolveDocHref resolves relative links from the source file', () => {
    assert.equal(resolveDocHref('./fetch-data.md', 'docs/reference/swift/insert-data.md'), '/docs/reference/swift/fetch-data')
    assert.equal(resolveDocHref('../kotlin/insert-data.md#examples', 'docs/reference/swift/insert-data.md'), '/docs/reference/kotlin/insert-data#examples')
    assert.equal(resolveDocHref('../../cli/configuration.md', 'docs/reference/swift/types.md'), '/docs/configuration')
    assert.equal(resolveDocHref('../reference/swift/introduction.md', 'docs/getting-started/native-clients.md'), '/docs/reference/swift/introduction')
  })

  test('every library links from the global nav under Client libraries', () => {
    const nav = getDocsNavEntries()

    for (const library of REFERENCE_LIBRARIES) {
      assert.ok(
        nav.some((item) => item.href === referenceHref(library.id, 'introduction') && item.subgroup === 'Client libraries'),
        library.id,
      )
    }
  })

  // Shared Database CRUD + filter guides that mirror the matching Supabase client language.
  const SUPABASE_SHAPED_SLUGS = new Set([
    'fetch-data',
    'insert-data',
    'update-data',
    'delete-data',
    'using-filters',
    'apply-where',
  ])

  // Primary Supabase method slug expected on each Supabase-shaped CRUD page.
  const SUPABASE_SHAPED_PRIMARY_METHOD: Record<string, string> = {
    'fetch-data': 'select',
    'insert-data': 'insert',
    'update-data': 'update',
    'delete-data': 'delete',
    'using-filters': 'using-filters',
    'apply-where': 'using-filters',
  }

  // Library id → Supabase docs language path segment for deferral links.
  const SUPABASE_REFERENCE_LANG: Record<string, string> = {
    swift: 'swift',
    kotlin: 'kotlin',
    javascript: 'javascript',
    react: 'javascript',
    vue: 'javascript',
    expo: 'javascript',
  }

  // Dead short paths that 404 on supabase-js; use using-filters-* / using-modifiers-* / file-buckets-* instead.
  const DEAD_JAVASCRIPT_SUPABASE_PATHS =
    /supabase\.com\/docs\/reference\/javascript\/(?:eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|containedby|or|and|not|order|limit|single|maybesingle|filter|textsearch|overlaps|match|range|storage-from-upload)(?:\/|"|'|\s|\)|$)/i

  // Method / filter tokens that must be markdown-linked when written as `.name` or `.name()` in Database prose.
  const LINKABLE_API_TOKENS = [
    'select',
    'insert',
    'update',
    'delete',
    'upsert',
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'like',
    'ilike',
    'is',
    'in',
    'contains',
    'containedBy',
    'or',
    'and',
    'not',
    'filter',
    'match',
    'overlaps',
    'textSearch',
    'search',
    'order',
    'limit',
    'single',
    'maybeSingle',
    'range',
    'csv',
  ] as const

  test('method pages ban placeholder Parameters and enforce Supabase-shaped vs full content', () => {
    for (const library of REFERENCE_LIBRARIES) {
      for (const page of library.pages.filter((entry) => entry.kind === 'method' || entry.kind === 'guide')) {
        const file = referencePageFile(library.id, page.slug)
        const { body } = frontmatterOf(readFileSync(join(REPO_ROOT, file), 'utf8'))

        assert.doesNotMatch(body, /\|\s*see example\s*\|/i, `placeholder Parameters row: ${file}`)

        const isSupabaseShaped = SUPABASE_SHAPED_SLUGS.has(page.slug)

        if (isSupabaseShaped) {
          assert.match(body, /https:\/\/supabase\.com\/docs\/reference\//, `Supabase-shaped page needs a Supabase reference link: ${file}`)
          assert.match(
            body,
            /offline-writes\.md|how-kizuna-works\.md|outbox|local SQLite|local store/i,
            `Supabase-shaped Notes must cover local-first deltas: ${file}`,
          )
          const lang = SUPABASE_REFERENCE_LANG[library.id]

          if (lang !== undefined) {
            assert.match(
              body,
              new RegExp(`https://supabase\\.com/docs/reference/${lang}/`),
              `Supabase-shaped page must defer to matching language (${lang}): ${file}`,
            )
            assert.doesNotMatch(body, DEAD_JAVASCRIPT_SUPABASE_PATHS, `dead supabase-js short path: ${file}`)
          }
        }

        if (page.kind !== 'method') {
          continue
        }

        assert.ok(body.includes('## Parameters'), `method page needs ## Parameters: ${file}`)
        assert.ok(body.includes('## Notes'), `method page needs ## Notes: ${file}`)
        assert.ok(body.includes('| Name | Type | Required | Description |'), `parameter table header: ${file}`)

        const parameters = body.split('## Parameters')[1]?.split(/^## /m)[0] ?? ''
        const dataRows = parameters
          .split('\n')
          .filter((line) => /^\|/.test(line) && !/^\|\s*-/.test(line) && !/^\|\s*Name\s*\|/.test(line))

        assert.ok(dataRows.length >= 1, `Parameters needs a real row: ${file}`)
        assert.doesNotMatch(parameters, /\|\s*see example\s*\|/i, file)

        if (!isSupabaseShaped) {
          assert.ok(body.includes('## Returns'), `full Kizuna method needs ## Returns: ${file}`)
        }
      }
    }
  })

  test('native CRUD pages link the matching Supabase language primary method', () => {
    for (const libraryId of ['swift', 'kotlin'] as const) {
      const library = findReferenceLibrary(libraryId)

      assert.ok(library !== undefined, libraryId)

      for (const [slug, method] of Object.entries(SUPABASE_SHAPED_PRIMARY_METHOD)) {
        const page = library.pages.find((entry) => entry.slug === slug)

        if (page === undefined) {
          continue
        }
        const file = referencePageFile(libraryId, slug)
        const source = readFileSync(join(REPO_ROOT, file), 'utf8')

        assert.match(
          source,
          new RegExp(`https://supabase\\.com/docs/reference/${libraryId}/${method}(?:[)#/"'\\s]|$)`),
          `${file} must link supabase.com/docs/reference/${libraryId}/${method}`,
        )
      }
    }
  })

  test('native client pages never defer to Supabase JavaScript reference paths', () => {
    for (const libraryId of ['swift', 'kotlin'] as const) {
      const library = findReferenceLibrary(libraryId)

      assert.ok(library !== undefined, libraryId)

      for (const page of library.pages) {
        const file = referencePageFile(libraryId, page.slug)
        const source = readFileSync(join(REPO_ROOT, file), 'utf8')

        assert.doesNotMatch(
          source,
          /supabase\.com\/docs\/reference\/javascript\//,
          `${file} must not link supabase.com/docs/reference/javascript/`,
        )

      }
    }
  })

  test('JS-family pages never point at Swift or Kotlin Supabase reference URLs', () => {
    for (const libraryId of ['javascript', 'react', 'vue', 'expo'] as const) {
      const library = findReferenceLibrary(libraryId)

      assert.ok(library !== undefined, libraryId)

      for (const page of library.pages) {
        const file = referencePageFile(libraryId, page.slug)
        const source = readFileSync(join(REPO_ROOT, file), 'utf8')

        assert.doesNotMatch(
          source,
          /supabase\.com\/docs\/reference\/(?:swift|kotlin)\//,
          `${file} must not link Swift/Kotlin Supabase reference URLs`,
        )
        assert.doesNotMatch(source, DEAD_JAVASCRIPT_SUPABASE_PATHS, `dead supabase-js short path: ${file}`)

      }
    }
  })

  test('Database prose links mentioned Supabase-shaped method and filter names', () => {
    const tokenPattern = new RegExp(
      String.raw`(?:\`\.` +
        `(?:${LINKABLE_API_TOKENS.join('|')})` +
        String.raw`(?:\(\))?` +
        String.raw`\`|\.` +
        `(?:${LINKABLE_API_TOKENS.join('|')})` +
        String.raw`\(\))`,
      'g',
    )

    for (const library of REFERENCE_LIBRARIES) {
      for (const page of library.pages.filter((entry) => entry.section === 'Database' || SUPABASE_SHAPED_SLUGS.has(entry.slug))) {
        const file = referencePageFile(library.id, page.slug)
        const { body } = frontmatterOf(readFileSync(join(REPO_ROOT, file), 'utf8'))

        for (const [line, textLine] of proseLines(body)) {
          const stripped = textLine.replace(/\[[^\]]*\]\([^)]+\)/g, '')
          const bare = stripped.match(tokenPattern)

          assert.equal(
            bare,
            null,
            `unlinked API token ${bare?.join(', ') ?? ''} at ${file}:${line} (link the Supabase or Kizuna counterpart on this line)`,
          )
        }
      }
    }
  })
})

/** Parses every tracked Markdown file: fast alone, but a CI runner also building crates needs more than the default five seconds. */
const MARKDOWN_LINKS_TIMEOUT_MS = 60_000

describe('repository Markdown links', () => {
  test('all tracked local targets and heading anchors resolve', { timeout: MARKDOWN_LINKS_TIMEOUT_MS }, () => {
    const tracked = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter((file) => file.length > 0 && existsSync(join(REPO_ROOT, file)))
    const anchorCache = new Map<string, Set<string>>()
    const anchorsFor = (path: string): Set<string> => {
      const cached = anchorCache.get(path)

      if (cached !== undefined) {
        return cached
      }
      const anchors = markdownAnchors(readFileSync(path, 'utf8'))

      anchorCache.set(path, anchors)

      return anchors
    }

    for (const file of tracked) {
      const sourcePath = join(REPO_ROOT, file)
      const source = readFileSync(sourcePath, 'utf8')

      for (const link of markdownLinks(source)) {
        const fragment = decodedFragment(link.href)
        const context = `${file}:${link.line} -> ${link.href}`

        if (link.href.startsWith('#')) {
          assert.ok(fragment !== null && anchorsFor(sourcePath).has(fragment), `missing Markdown anchor: ${context}`)
          continue
        }

        const localPath = localPathFromHref(link.href)

        if (localPath === null) {
          continue
        }
        const targetPath = resolve(dirname(sourcePath), localPath)

        assert.ok(existsSync(targetPath), `broken tracked Markdown link: ${context}`)

        if (fragment !== null && targetPath.endsWith('.md')) {
          assert.ok(anchorsFor(targetPath).has(fragment), `missing target Markdown anchor: ${context}`)
        }
      }
    }
  })
})

function interfaceMembers(source: string, name: string): string[] {
  const start = source.search(new RegExp(`export interface ${name}\\b`))

  assert.ok(start >= 0, name)
  const brace = source.indexOf('{', start)
  let depth = 0
  let end = brace

  for (let index = brace; index < source.length; index += 1) {
    const char = source[index]

    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1

      if (depth === 0) {
        end = index
        break
      }
    }
  }
  return source
    .slice(brace + 1, end)
    .split('\n')
    .map((line) => line.match(/^\s+(?:readonly\s+)?([A-Za-z][A-Za-z0-9]*)\??\s*[:(]/)?.[1])
    .filter((name): name is string => name !== undefined)
}

function topLevelReturnNames(body: string): string[] {
  const section = body.split('## Returns')[1]?.split(/^## /m)[0] ?? ''

  return section
    .split('\n')
    .map((line) => line.match(/^\| `([^`.]+)` /)?.[1])
    .filter((name): name is string => name !== undefined)
}

function readmeHookMembers(readme: string, hook: string): string[] {
  const line = readme.split('\n').find((row) => row.includes(`\`${hook}`))
  const span = line?.match(/\{ ([^}]+) \}/)?.[1]

  return span === undefined ? [] : span.split(', ')
}

describe('hook and CLI surfaces stay pinned to their owners', () => {
  test('useSyncStatus and useAttachment Returns tables match the interfaces', () => {
    const pairs = [
      {
        file: 'docs/reference/react/use-sync-status.md',
        source: 'packages/react/src/use-sync-status.ts',
        name: 'ISyncStatusResult',
      },
      {
        file: 'docs/reference/vue/use-sync-status.md',
        source: 'packages/vue/src/use-sync-status.ts',
        name: 'IUseSyncStatusResult',
      },
      {
        file: 'docs/reference/react/use-attachment.md',
        source: 'packages/react/src/use-attachment.ts',
        name: 'IUseAttachmentResult',
      },
      {
        file: 'docs/reference/vue/use-attachment.md',
        source: 'packages/vue/src/use-attachment.ts',
        name: 'IUseAttachmentResult',
      },
    ]

    for (const pair of pairs) {
      const members = interfaceMembers(readFileSync(join(REPO_ROOT, pair.source), 'utf8'), pair.name)
      const body = readFileSync(join(REPO_ROOT, pair.file), 'utf8').replace(/^---[\s\S]*?---\n/, '')
      const rows = topLevelReturnNames(body)

      assert.deepEqual(rows, members, pair.file)
    }
  })

  test('the Sync health Returns table lists every ISyncHealth member', () => {
    const members = interfaceMembers(readFileSync(join(REPO_ROOT, 'packages/core/src/host/sync-health.ts'), 'utf8'), 'ISyncHealth')
    const body = readFileSync(join(REPO_ROOT, 'docs/reference/javascript/sync-health.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '')
    const rows = topLevelReturnNames(body)

    assert.ok(members.length > 0)
    assert.deepEqual(members.filter((member) => !rows.includes(member)), [])
  })

  test('package README hook rows list every interface member', () => {
    const reactReadme = readFileSync(join(REPO_ROOT, 'packages/react/README.md'), 'utf8')
    const vueReadme = readFileSync(join(REPO_ROOT, 'packages/vue/README.md'), 'utf8')
    const sameMembers = (actual: string[], expected: string[]): void => {
      assert.deepEqual([...actual].sort(), [...expected].sort())
    }
    sameMembers(
      readmeHookMembers(reactReadme, 'useSyncStatus'),
      interfaceMembers(readFileSync(join(REPO_ROOT, 'packages/react/src/use-sync-status.ts'), 'utf8'), 'ISyncStatusResult'),
    )
    sameMembers(
      readmeHookMembers(vueReadme, 'useSyncStatus'),
      interfaceMembers(readFileSync(join(REPO_ROOT, 'packages/vue/src/use-sync-status.ts'), 'utf8'), 'IUseSyncStatusResult'),
    )
    sameMembers(
      readmeHookMembers(reactReadme, 'useAttachment'),
      interfaceMembers(readFileSync(join(REPO_ROOT, 'packages/react/src/use-attachment.ts'), 'utf8'), 'IUseAttachmentResult'),
    )
    sameMembers(
      readmeHookMembers(vueReadme, 'useAttachment'),
      interfaceMembers(readFileSync(join(REPO_ROOT, 'packages/vue/src/use-attachment.ts'), 'utf8'), 'IUseAttachmentResult'),
    )
  })

  test('kizunasync doctor pack checks in cli.md match the CLI id list', () => {
    const cli = readFileSync(join(REPO_ROOT, 'docs/cli/cli.md'), 'utf8')
    const pack = [
      'pg-cron',
      'jobs',
      'job-runs',
      'core-rpcs',
      'triggers',
      'table-primary-key',
      'sync-key',
      'rls-enabled',
      'trigger-search-path',
      'change-stamp',
      'realtime-policy',
      'role-and-grants',
      'column-privileges',
      'require-atomic',
      'ledger',
    ]
    const section = cli.split('## `kizunasync doctor`')[1]?.split('## ')[0] ?? ''

    assert.match(section, /fifteen checks that read what the pack installed/)
    assert.match(cli, /Runs twenty-one project checks/)

    for (const id of pack) {
      assert.match(section, new RegExp(`\\| \`${id}\` \\|`), id)
    }
  })

  test('rust-ci clippy flags match turbo.json kizunasync-cargo#lint', () => {
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { command?: string[] }>
    }
    const command = turbo.tasks['kizunasync-cargo#lint']?.command ?? []
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/rust-ci.yml'), 'utf8')
    const step = workflow.split('- name: cargo clippy')[1]?.split('- name:')[0] ?? ''

    for (const token of command) {
      assert.ok(step.includes(token), `clippy step missing ${token}`)
    }
  })

  test('toolchain table matches packageManager, engines, and workflow BUN_VERSION', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      packageManager: string
      engines: { bun: string; node: string }
    }
    const bunExact = pkg.packageManager.replace(/^bun@/, '')
    const page = readFileSync(join(REPO_ROOT, 'docs/operations/ci-cd.md'), 'utf8')

    assert.ok(page.includes(`\`${pkg.packageManager}\``), 'packageManager')
    assert.ok(page.includes(`\`${pkg.engines.bun}\``), 'engines.bun')
    assert.ok(page.includes('`1.4.2`') && bunExact === '1.4.2', 'workflow bun')

    for (const file of ['ci.yml', 'rust-ci.yml', 'release-npm.yml', 'deploy-demo.yml', 'deploy-website.yml']) {
      const text = readFileSync(join(REPO_ROOT, '.github/workflows', file), 'utf8')

      assert.match(text, new RegExp(`BUN_VERSION:\\s*${bunExact}`), file)
    }
    const cargo = readFileSync(join(REPO_ROOT, 'Cargo.toml'), 'utf8')
    const msrv = cargo.match(/rust-version\s*=\s*"([^"]+)"/)?.[1]

    assert.ok(msrv === '1.90')
    const contribute = readFileSync(join(REPO_ROOT, 'docs/resources/contribute.md'), 'utf8')

    assert.ok(contribute.includes(msrv ?? ''), 'contribute MSRV')
  })

  test('SECRET_NAMES matches secrets referenced by release-*.yml', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts/sync-release-secrets.ts'), 'utf8')
    const block = script.split('const SECRET_NAMES = [')[1]?.split(']')[0] ?? ''
    const names = [...block.matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1]).sort()
    const workflows = ['release-npm.yml', 'release-kotlin.yml', 'release-swift.yml', 'release.yml']
      .flatMap((file) => {
        const text = readFileSync(join(REPO_ROOT, '.github/workflows', file), 'utf8')

        return [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1])
      })
      .filter((name) => name !== 'GITHUB_TOKEN')
    const unique = [...new Set(workflows)].sort()

    assert.deepEqual(names, unique)
  })

  test('ci.yml and rust-ci.yml trigger on develop, pull requests, a full workflow_call, and manual dispatch, matching ci-cd.md', () => {
    for (const file of ['ci.yml', 'rust-ci.yml']) {
      const workflow = readFileSync(join(REPO_ROOT, '.github/workflows', file), 'utf8')

      assert.match(workflow, /push:\n    branches: \[develop\]/, file)
      assert.match(workflow, /\n {2}pull_request:\n/, file)
      assert.match(workflow, /workflow_call:\n    inputs:\n {6}full:/, file)
      assert.match(workflow, /\n {2}workflow_dispatch:\n/, file)
    }
    const page = readFileSync(join(REPO_ROOT, 'docs/operations/ci-cd.md'), 'utf8')

    assert.match(page, /rust-ci\.yml` \| Push to `develop`, pull request to any branch, reusable `workflow_call` from `release\.yml`, manual dispatch from `main`/)
    const rustLead = page.split('## Rust workflow')[1]?.split('\n\n')[1] ?? ''

    assert.match(rustLead, /develop/)
    assert.match(rustLead, /pull request/)
  })

  test('ci-cd.md names every workflow file and states their count', () => {
    const files = readdirSync(join(REPO_ROOT, '.github/workflows')).filter((name) => name.endsWith('.yml')).sort()
    const page = readFileSync(join(REPO_ROOT, 'docs/operations/ci-cd.md'), 'utf8')
    const table = page.split('## Workflows\n')[1]?.split('\n## ')[0] ?? ''
    const listed = [...table.matchAll(/^\| `([a-z-]+\.yml)` \|/gm)].map((match) => match[1]).sort()
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

    assert.deepEqual(listed, files)
    assert.match(page, new RegExp(`The repository has ${words[files.length]} GitHub Actions workflows\\.`))
  })
})
