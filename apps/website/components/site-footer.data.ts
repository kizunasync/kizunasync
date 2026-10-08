import { GITHUB_URL } from '@/lib/site'

export const SITE_FOOTER_COLUMNS = [
  {
    title: 'Project',
    links: [
      { label: 'GitHub', href: GITHUB_URL },
      { label: 'Protocol corpus', href: `${GITHUB_URL}/tree/main/packages/protocol` },
      { label: 'Governance', href: `${GITHUB_URL}/blob/main/GOVERNANCE.md` },
      { label: 'Feedback', href: '/feedback' },
    ],
  },
  {
    title: 'Docs',
    links: [
      { label: 'All docs', href: '/docs' },
      { label: 'Client libraries', href: '/docs/reference' },
      { label: 'Product & fit', href: '/docs/introduction' },
      { label: 'Protocol overview', href: '/docs/protocol-overview' },
      { label: 'Attachments', href: '/docs/media-and-attachments' },
      { label: 'Architecture', href: '/docs/architecture-overview' },
    ],
  },
  {
    title: 'Compare',
    links: [
      { label: 'vs PowerSync', href: '/compare#powersync' },
      { label: 'vs Electric', href: '/compare#electric' },
      { label: 'vs Zero', href: '/compare#zero' },
      { label: 'vs Legend-State', href: '/compare#legend-state' },
      { label: 'vs RxDB', href: '/compare#rxdb' },
      { label: 'vs WatermelonDB', href: '/compare#watermelondb' },
      { label: 'vs TinyBase', href: '/compare#tinybase' },
      { label: 'vs Triplit', href: '/compare#triplit' },
      { label: 'vs InstantDB', href: '/compare#instantdb' },
      { label: 'vs Firestore', href: '/compare#firestore' },
      { label: 'vs a custom build', href: '/compare#a-typical-custom-implementation' },
      { label: 'When NOT to use it', href: '/#honesty' },
    ],
  },
] as const
