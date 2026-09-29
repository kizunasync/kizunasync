'use client'

import { useId, useState } from 'react'

// MARK: - FeatureSpotlight

interface IFeatureSpotlightItem {
  icon: string
  title: string
  body: readonly string[]
  href: string
}

type TFeatureSpotlightCatalog = readonly [
  IFeatureSpotlightItem,
  IFeatureSpotlightItem,
  IFeatureSpotlightItem,
  IFeatureSpotlightItem,
  IFeatureSpotlightItem,
  IFeatureSpotlightItem,
  IFeatureSpotlightItem,
  IFeatureSpotlightItem,
  IFeatureSpotlightItem,
  IFeatureSpotlightItem,
]

export function FeatureSpotlight({
  features,
}: {
  features: TFeatureSpotlightCatalog
}) {
  const [activeIndex, setActiveIndex] = useState(0)
  const detailId = useId()
  const splitIndex = Math.ceil(features.length / 2)

  return (
    <>
      <div className="border-site-border bg-site-surface/20 relative overflow-hidden rounded-xl border xl:min-h-[34rem] xl:pl-[36%]">
        <ol className="min-w-0 xl:grid xl:grid-flow-col xl:grid-cols-2 xl:grid-rows-5">
          {features.map((feature, index) => (
            <FeatureSpotlightItem
              key={feature.title}
              feature={feature}
              detailId={detailId}
              index={index}
              isActive={index === activeIndex}
              isRightColumn={index >= splitIndex}
              isSplitBoundary={index === splitIndex - 1}
              isLastItem={index === features.length - 1}
              onSelect={() => setActiveIndex(index)}
            />
          ))}
        </ol>
      </div>
      <FeatureSpotlightNoScript features={features} />
    </>
  )
}

// MARK: - FeatureSpotlightItem

function FeatureSpotlightItem({
  feature,
  detailId,
  index,
  isActive,
  isRightColumn,
  isSplitBoundary,
  isLastItem,
  onSelect,
}: {
  feature: IFeatureSpotlightItem
  detailId: string
  index: number
  isActive: boolean
  isRightColumn: boolean
  isSplitBoundary: boolean
  isLastItem: boolean
  onSelect: () => void
}) {
  const triggerId = `${detailId}-trigger-${index}`
  const panelId = `${detailId}-panel-${index}`

  return (
    <li
      className={`border-site-border/70 border-b p-2 ${
        isRightColumn ? 'xl:border-l' : ''
      } ${isSplitBoundary ? 'xl:border-b-0' : ''} ${
        isLastItem ? 'border-b-0' : ''
      }`}
    >
      <button
        id={triggerId}
        type="button"
        aria-expanded={isActive}
        aria-controls={panelId}
        onClick={onSelect}
        className={`group relative flex min-h-20 w-full touch-manipulation items-center gap-3 rounded-lg border px-4 py-3 text-left transition-[background-color,border-color,color] sm:px-5 xl:min-h-[5.8rem] ${
          isActive
            ? "border-site-accent bg-site-raised/45 text-site-text before:bg-site-accent before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-l-lg before:content-['']"
            : 'text-site-text hover:bg-site-raised/25 border-transparent'
        }`}
      >
        <span
          className="nf text-site-accent w-7 shrink-0 text-2xl"
          aria-hidden="true"
        >
          {feature.icon}
        </span>
        <span
          className={`min-w-0 flex-1 text-sm sm:text-base ${
            isActive ? 'font-semibold' : 'font-medium'
          }`}
        >
          {feature.title}
        </span>
        <span
          className="text-site-faint group-hover:text-site-accent shrink-0 text-lg transition-colors"
          aria-hidden="true"
        >
          →
        </span>
      </button>

      <FeatureSpotlightDetail feature={feature} triggerId={triggerId} panelId={panelId} isActive={isActive} />
    </li>
  )
}

// MARK: - FeatureSpotlightDetail

function FeatureSpotlightDetail({
  feature,
  triggerId,
  panelId,
  isActive,
}: {
  feature: IFeatureSpotlightItem
  triggerId: string
  panelId: string
  isActive: boolean
}) {
  return (
    <article
      id={panelId}
      role="region"
      aria-labelledby={triggerId}
      hidden={!isActive}
      className="border-site-border/70 bg-site-surface/20 border-t p-6 sm:p-8 xl:absolute xl:inset-y-0 xl:left-0 xl:flex xl:w-[36%] xl:flex-col xl:border-t-0 xl:border-r xl:p-10"
    >
      <span
        className="nf text-site-accent text-4xl sm:text-5xl"
        aria-hidden="true"
      >
        {feature.icon}
      </span>
      <h3 className="font-display mt-6 text-2xl font-bold tracking-tight sm:text-3xl">
        {feature.title}
      </h3>
      <div className="text-site-muted mt-5 space-y-4 text-base leading-relaxed sm:text-lg">
        {feature.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <a
        href={feature.href}
        className="text-site-muted hover:text-site-accent mt-8 inline-flex min-h-11 w-fit touch-manipulation items-center gap-2 text-base transition-colors xl:mt-auto"
      >
        Read the technical details
        <span className="sr-only"> for {feature.title}</span>
        <span aria-hidden="true">→</span>
      </a>
    </article>
  )
}

// MARK: - FeatureSpotlightNoScript

function FeatureSpotlightNoScript({ features }: { features: TFeatureSpotlightCatalog }) {
  return (
    <noscript>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {features.map((feature) => (
          <li key={feature.title}>
            <a
              href={feature.href}
              className="border-site-border bg-site-surface/20 hover:border-site-accent flex h-full min-h-11 flex-col rounded-lg border p-4 transition-colors"
            >
              <span className="font-medium">{feature.title}</span>
              <span className="text-site-muted mt-2 text-sm leading-relaxed">
                {feature.body.join(' ')}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </noscript>
  )
}
