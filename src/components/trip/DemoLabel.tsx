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
        'inline-flex w-fit items-center gap-1.5 rounded-full bg-sun-soft px-2.5 py-0.5 text-[11px] font-semibold text-sun-foreground ring-1 ring-inset ring-sun',
        className,
      )}
    >
      <FlaskConical className="h-3 w-3 shrink-0" aria-hidden />
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
      className="flex items-start gap-3 rounded-xl border border-sun bg-sun-soft px-4 py-3 text-sm shadow-[0_6px_20px_-14px_rgba(168,90,0,0.6)]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sun text-sun-foreground">
        <FlaskConical className="h-4 w-4" aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold" data-testid="demo-label">
          {DEMO_LABEL}
        </p>
        <p className="text-foreground/80">
          Live flight prices are unavailable from our data provider right now, so this trip uses saved sample
          fares to show how Halfway works. Voting, locking and the booking checklist work for real. {DEMO_EMAILS_OFF}
        </p>
      </div>
    </div>
  )
}
