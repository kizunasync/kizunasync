/** Lowercase-hyphen slug of a heading's text: 'Protocol & SQL rules' -> 'protocol-sql-rules'. */
export function headingSlug(heading: string): string {
  return heading
    .replace(/^#{1,6}\s+/, '')
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/ +/g, '-')
}
