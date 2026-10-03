/**
 * The one external link this app renders: a plain anchor, not an interactive
 * HeroUI control, so `onPress` does not apply here.
 */
export function ScheduleLink({ schedule, href }: { schedule: string; href: string }) {
  return (
    <a
      className="text-site-accent hover:text-site-accent-bright underline underline-offset-2"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {schedule}
    </a>
  )
}
