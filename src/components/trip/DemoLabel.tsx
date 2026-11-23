/**
 * The demo-trip label (SPEC §14): shown on every demo screen and card so
 * sample prices are never mistaken for live fares. One wording everywhere
 * (`DEMO_LABEL`); the banner adds why demo trips exist.
 */
import { FlaskConical } from 'lucide-react'
import { cn } from '@/components/ui'
import { DEMO_EMAILS_OFF, DEMO_LABEL } from '@/lib/demo'

/** Compact label for cards. */
export function DemoLabel({ className }: { className?: string }) {
  return (
    <p
      data-testid="demo-label"
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs font-semibold text-foreground',
        className,
      )}
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      {DEMO_LABEL}
    </p>
  )
}

/** Full-width banner at the top of a demo trip's page, above every tab. */
export function DemoBanner() {
  return (
    <div
      role="note"
      data-testid="demo-banner"
      className="flex items-start gap-3 rounded-lg border-2 border-warning bg-warning/10 px-4 py-3 text-sm"
    >
      <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold" data-testid="demo-label">
          {DEMO_LABEL}
        </p>
        <p className="text-muted-foreground">
          Live flight prices are unavailable from our data provider right now, so this trip uses saved sample
          fares to show how Halfway works. Voting, locking and the booking checklist work for real. {DEMO_EMAILS_OFF}
        </p>
      </div>
    </div>
  )
}
