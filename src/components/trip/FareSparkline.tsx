/**
 * A small line of one destination's group total over time, from
 * `fareSnapshots` (one point per complete check). Single series: no legend,
 * the caption names it. Each point has a hover/tap title, and the same
 * numbers are in a screen-reader list.
 */
import { usd } from '@/lib/results'

export interface SparkPoint {
  checkedAt: string
  total: number
}

const W = 240
const H = 56
const PAD = 6

function pointLabel(p: SparkPoint): string {
  const d = new Date(p.checkedAt)
  const when = Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : p.checkedAt
  return `${when}: ${usd(p.total)}`
}

export function FareSparkline({ points, label }: { points: SparkPoint[]; label: string }) {
  const n = points.length
  const totals = points.map((p) => p.total)
  const min = Math.min(...totals)
  const max = Math.max(...totals)
  const x = (i: number) => (n === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n - 1))
  // A flat history sits in the middle rather than on an edge.
  const y = (v: number) => (max === min ? H / 2 : PAD + ((max - v) * (H - 2 * PAD)) / (max - min))
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(' ')

  return (
    <figure className="m-0" data-testid="fare-sparkline" data-points={n}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-14 w-full max-w-[240px] overflow-visible text-primary"
        role="img"
        aria-label={`${label}: ${n} ${n === 1 ? 'check' : 'checks'}, latest ${usd(totals[n - 1] ?? null)}`}
      >
        <line x1={0} x2={W} y1={H - 1} y2={H - 1} className="stroke-border" strokeWidth={1} />
        {n > 1 && (
          <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {/* The latest check gets a visible marker with a surface ring. */}
        {n > 0 && (
          <circle cx={x(n - 1)} cy={y(totals[n - 1])} r={4} fill="currentColor" className="stroke-card" strokeWidth={2} />
        )}
        {/* Generous invisible hit targets carry each point's value. */}
        {points.map((p, i) => (
          <circle key={`${p.checkedAt}-${i}`} cx={x(i)} cy={y(p.total)} r={10} fill="transparent" className="cursor-default">
            <title>{pointLabel(p)}</title>
          </circle>
        ))}
      </svg>
      <ul className="sr-only">
        {points.map((p, i) => (
          <li key={`${p.checkedAt}-${i}`}>{pointLabel(p)}</li>
        ))}
      </ul>
    </figure>
  )
}
