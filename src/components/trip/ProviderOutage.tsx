/**
 * Shown when the last fare search or watch check stopped because the flight
 * data provider was out of quota or rate-limited (SPEC §7 "Integration
 * failures"). The first sentence is the stored message (developer wording,
 * SPEC #32); the rest says in plain words what it means and that the rest of
 * the trip still works. It never shows provider text.
 */
import { CloudOff } from 'lucide-react'
import { PROVIDER_UNAVAILABLE_MESSAGE } from '@/lib/flights'

export function isProviderOutage(message: string | null | undefined): boolean {
  return message === PROVIDER_UNAVAILABLE_MESSAGE
}

export function ProviderOutage({ retryHint, testId = 'provider-banner' }: { retryHint: string; testId?: string }) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
    >
      <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-medium">{PROVIDER_UNAVAILABLE_MESSAGE}</p>
        <p className="text-muted-foreground">
          The service Halfway gets flight prices from isn’t answering right now. Nothing is wrong with your trip,
          and everything else still works: your settings, destinations, votes and booking links. {retryHint}
        </p>
      </div>
    </div>
  )
}
