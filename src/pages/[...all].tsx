/**
 * 404 — static (top level of src/pages/), so it mounts no providers and can't
 * know whether you're signed in. Both ways out work either way.
 */
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { pageTitle } from '../brand'

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-16 text-center">
      <title>{pageTitle('Page not found')}</title>
      <meta name="robots" content="noindex" />
      <svg viewBox="0 0 200 80" className="h-20 w-52" aria-hidden>
        <path d="M16 64 Q70 6 124 40" pathLength={1} className="fill-none stroke-foreground" strokeWidth={2} strokeDasharray="0.03 0.025" />
        <circle cx={16} cy={64} r={6} className="fill-card stroke-foreground" strokeWidth={2} />
        <text x={160} y={52} textAnchor="middle" className="fill-primary font-mono text-[28px] font-medium">
          ?
        </text>
      </svg>
      <p className="mt-4 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Error 404</p>
      <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight">This route doesn’t land anywhere</h1>
      <p className="mt-3 max-w-sm text-muted-foreground">
        The page may have moved, or the link was cut short. Invite links look like /join/ followed by a code.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
        <Link
          to="/trips"
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Go to your trips <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
        <Link to="/" className="text-sm font-medium underline underline-offset-4 hover:text-primary">
          Halfway home
        </Link>
      </div>
    </div>
  )
}
