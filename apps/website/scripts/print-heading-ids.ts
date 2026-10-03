/**
 * Prints the heading ids rehype-slug would assign when DocMarkdown renders
 * the given file, one per line as `<depth>\t<id>\t<text>`.
 * Run: bun scripts/print-heading-ids.ts <path/to/file.md>
 */
import { readFileSync } from 'node:fs'
import { headingIds } from '../lib/heading-ids'
import { parseDocSource } from '../lib/docs'

const path = process.argv[2]

if (path === undefined) {
  console.error('Usage: bun scripts/print-heading-ids.ts <path/to/file.md>')
  process.exit(1)
}

const { content } = parseDocSource(readFileSync(path, 'utf8'))

for (const { depth, id, text } of headingIds(content)) {
  console.log(`${depth}\t${id}\t${text}`)
}
