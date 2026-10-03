'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { DocsNavSectionHeading } from '@/components/docs-nav-section-heading'
import { DOC_GROUPS, type IDocNavEntry } from '@/lib/docs-registry'

// MARK: - DocsNavList: grouped nav shared by the sidebar and the mobile drawer.

interface INavSection {
  subgroup?: string
  docs: IDocNavEntry[]
}

function sectionsForGroup(docs: IDocNavEntry[], group: string): INavSection[] {
  const sections: INavSection[] = []

  for (const doc of docs.filter((entry) => entry.group === group)) {
    const last = sections.at(-1)

    if (last !== undefined && last.subgroup === doc.subgroup) {
      last.docs.push(doc)
    } else {
      sections.push({ subgroup: doc.subgroup, docs: [doc] })
    }
  }
  return sections
}

export function DocsNavList({
  docs,
  onNavigate,
}: {
  docs: IDocNavEntry[]
  onNavigate?: () => void
}) {
  const pathname = usePathname()

  return (
    <nav aria-label="Documentation" className="space-y-6">
      {DOC_GROUPS.map((group) => (
        <div key={group}>
          <DocsNavSectionHeading>{group}</DocsNavSectionHeading>
          <div className="mt-2 space-y-3">
            {sectionsForGroup(docs, group).map((section) => (
              <div key={section.subgroup ?? '_root'}>
                {section.subgroup !== undefined ? (
                  <p className="text-site-faint mt-1 mb-1 px-2.5 text-[11px] tracking-wide">{section.subgroup}</p>
                ) : null}
                <ul className="space-y-0.5">
                  {section.docs.map((doc) => {
                    const active = pathname === doc.href
                    const showStatus = doc.status === 'alpha' || doc.status === 'beta'

                    return (
                      <li key={doc.slug}>
                        <Link
                          href={doc.href}
                          aria-current={active ? 'page' : undefined}
                          onClick={onNavigate}
                          className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                            active
                              ? 'bg-site-surface text-site-accent-bright font-medium'
                              : 'text-site-muted hover:text-site-text'
                          }`}
                        >
                          <span className="min-w-0 truncate">{doc.title}</span>
                          {showStatus ? (
                            <span className="border-site-accent text-site-accent shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] leading-none tracking-wide uppercase">
                              {doc.status?.toUpperCase()}
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ))}
    </nav>
  )
}
