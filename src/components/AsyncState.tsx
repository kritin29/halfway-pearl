/**
 * Shared loading / error-with-retry / empty states (CLAUDE.md: every async
 * UI has all four). Retrying never reloads the page: `Retryable` remounts its
 * children with a new key, which re-subscribes their `useQuery` calls.
 */
import { useState, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button, cn } from '@/components/ui'

export function LoadingState({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center justify-center gap-3 surface p-6 text-sm text-muted-foreground',
        className,
      )}
    >
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden />
      {label}
    </div>
  )
}

export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = 'Try again',
  className,
  testId,
}: {
  title: string
  message?: string | null
  onRetry?: () => void
  retryLabel?: string
  className?: string
  testId?: string
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn('rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-3', className)}
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm font-semibold text-destructive">{title}</p>
          {message && <p className="text-sm text-muted-foreground">{message}</p>}
          {onRetry && (
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export function EmptyNote({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-2xl border-2 border-dashed border-primary/25 bg-card/60 px-4 py-10 text-center', className)}>
      <p className="font-display text-base font-bold text-foreground">{title}</p>
      {children && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

/** Remount `children` on retry, so their queries subscribe again. */
export function Retryable({ children }: { children: (retry: () => void) => ReactNode }) {
  const [attempt, setAttempt] = useState(0)
  return <div key={attempt} className="contents">{children(() => setAttempt((a) => a + 1))}</div>
}
