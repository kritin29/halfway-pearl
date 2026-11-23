/**
 * Design Direction
 *
 * Product: A shared trip page where friends in different cities each enter
 *   their own airports and a private budget, and the group picks the city
 *   to meet in by total fare, fairness and arrival times.
 * Emotion: The group chat going quiet because the plan is settled:
 *   "everyone lands Friday before six."
 * Metaphor: A paper route map pinned to a corkboard, strings running from
 *   each friend's city to one vermilion pin.
 * References: Vignelli's 1972 NYC subway diagram; Swiss railway departure
 *   boards; a printed boarding pass's monospaced fields.
 * Signature: Dashed routes drawn from three origin cities that meet at one
 *   pin, each carrying a fare tag.
 * Hero: On load the three routes draw themselves one after another, their
 *   fare tags fade in, the pin drops on Nashville, and a result slip
 *   ("Group total $618, everyone lands within 1h 40m") settles beneath.
 *   Then nothing moves.
 *
 * Style Tile
 * - Color: "Timetable" (src/themes.css): oat paper, navy ink, terracotta
 *   pin where the routes meet; ochre, pine and slate as supporting hues.
 * - Type: Bricolage Grotesque (headings) + Inter (body) + IBM Plex Mono (airport codes,
 *   fares). A boarding pass's confidence over a ticket's precision.
 * - Theme: light. Planning happens on a phone at lunch, not in a dark room.
 * - Art direction: editorial modern minimalism; hairline rules, dashed
 *   routes, no gradients, no glass.
 * - Motion: stillness after one choreographed reveal (CSS keyframes in
 *   styles.css, skipped entirely under prefers-reduced-motion).
 * - Voice: second person; max 12 words per sentence; never "we"; no
 *   exclamation points.
 *
 * Static page: it lives at the top level of src/pages/, so no DeepSpace
 * providers mount (no auth fetch, no websocket), and prerender.ts renders it
 * to HTML at build. Keep it renderable without a browser.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, BellRing, Lock, PlaneLanding } from 'lucide-react'
import { Seo } from '../components/Seo'
import { seo } from '../seo'

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <div data-testid="static-landing" className="min-h-screen bg-background text-foreground">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
          <Wordmark />
          <Link
            to="/trips"
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Your trips <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </header>

        <main>
          <Hero />
          <HowItWorks />
          <Differentiators />
          <CallToAction />
        </main>

        <footer className="border-t border-border">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 font-mono text-xs uppercase tracking-wider text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <span>Halfway · Fares from Google Flights via SerpApi · Built on DeepSpace</span>
            <Link to="/trips" className="underline-offset-4 hover:text-foreground hover:underline">
              Your trips
            </Link>
          </div>
        </footer>
      </div>
    </>
  )
}

function Wordmark() {
  return (
    <Link to="/" className="inline-flex items-center gap-2" aria-label="Halfway home">
      <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
        <path d="M2 20 Q7 9 12 11" className="fill-none stroke-foreground" strokeWidth={1.6} strokeDasharray="2 2" />
        <path d="M22 20 Q17 9 12 11" className="fill-none stroke-foreground" strokeWidth={1.6} strokeDasharray="2 2" />
        <circle cx={12} cy={9} r={4} className="fill-primary" />
        <circle cx={12} cy={9} r={1.4} className="fill-background" />
      </svg>
      <span className="font-display text-xl font-semibold tracking-tight">Halfway</span>
    </Link>
  )
}

function Hero() {
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-6 sm:px-6 md:grid-cols-[1fr_1.1fr] md:pb-24 md:pt-12">
      <div className="flex flex-col items-start gap-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Group trip planner</p>
        <h1 className="font-display text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">
          Meet in the middle, <span className="text-primary">fairly.</span>
        </h1>
        <p className="max-w-md text-base text-muted-foreground sm:text-lg">
          Friends in different cities each add their own airports and a private budget. Halfway finds
          where the whole group should fly.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            to="/trips"
            data-testid="landing-start"
            className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Start a trip <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <a href="#how" className="text-sm font-medium underline underline-offset-4 hover:text-primary">
            How it works
          </a>
        </div>
      </div>
      <RouteMap />
    </section>
  )
}

/** Three friends' routes meeting at one pin. Decorative; the slip below carries the meaning. */
const ROUTES = [
  { code: 'SEA', fare: '$289', x: 44, y: 70, d: 'M44 70 Q120 40 236 176', tag: [130, 82], delay: 0 },
  { code: 'BOS', fare: '$198', x: 368, y: 58, d: 'M368 58 Q330 70 236 176', tag: [300, 84], delay: 0.35 },
  { code: 'MIA', fare: '$131', x: 340, y: 262, d: 'M340 262 Q300 200 236 176', tag: [300, 214], delay: 0.7 },
] as const

function RouteMap() {
  return (
    <figure className="relative rounded-2xl border border-border bg-card p-3 shadow-sm sm:p-4">
      <svg viewBox="0 0 400 300" className="block h-auto w-full" role="img" aria-labelledby="route-map-title">
        <title id="route-map-title">Routes from Seattle, Boston and Miami meeting in Nashville</title>
        <defs>
          <pattern id="map-dots" width="16" height="16" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1" className="fill-border" />
          </pattern>
        </defs>
        <rect width="400" height="300" rx="10" fill="url(#map-dots)" />

        {ROUTES.map((r) => (
          <g key={r.code}>
            <path
              d={r.d}
              pathLength={1}
              className="route-draw fill-none stroke-foreground"
              strokeWidth={2}
              strokeLinecap="round"
              style={{ animationDelay: `${r.delay}s` }}
            />
            <circle cx={r.x} cy={r.y} r={6} className="fill-card stroke-foreground" strokeWidth={2} />
            <text
              x={r.x}
              y={r.y < 150 ? r.y - 14 : r.y + 24}
              textAnchor="middle"
              className="fill-foreground font-mono text-[13px] font-medium"
            >
              {r.code}
            </text>
            <g className="route-fade" style={{ animationDelay: `${r.delay + 1}s` }}>
              <rect x={r.tag[0] - 30} y={r.tag[1] - 13} width={60} height={22} rx={4} className="fill-background stroke-border" />
              <text x={r.tag[0]} y={r.tag[1] + 2} textAnchor="middle" className="fill-foreground font-mono text-[12px]">
                {r.fare}
              </text>
            </g>
          </g>
        ))}

        <g className="route-pin" style={{ animationDelay: '1.5s' }}>
          <path d="M236 182 C226 166 222 160 222 152 a14 14 0 0 1 28 0 c0 8 -4 14 -14 30 z" className="fill-primary" />
          <circle cx={236} cy={152} r={5} className="fill-card" />
        </g>
        <text x={236} y={206} textAnchor="middle" className="route-fade fill-primary font-mono text-[13px] font-medium" style={{ animationDelay: '1.7s' }}>
          BNA
        </text>
      </svg>

      <figcaption
        className="route-fade mt-3 flex flex-col gap-2 rounded-xl border border-border bg-background p-4 sm:flex-row sm:items-end sm:justify-between"
        style={{ animationDelay: '2s' }}
      >
        <div>
          <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">BNA · Nashville</p>
          <p className="mt-1 font-display text-2xl font-semibold">Group total $618</p>
        </div>
        <ul className="flex flex-wrap gap-1.5 text-xs font-medium">
          <li className="rounded-full bg-success px-2.5 py-0.5 text-success-foreground">Low price</li>
          <li className="rounded-full bg-secondary px-2.5 py-0.5">Everyone lands within 1h 40m</li>
        </ul>
      </figcaption>
    </figure>
  )
}

const STEPS = [
  { n: '01', title: 'Start a trip', body: 'Share one invite link with the group.' },
  { n: '02', title: 'Everyone adds their own', body: 'Home airports, flight rules, and a budget only they see.' },
  { n: '03', title: 'Pick and book together', body: 'Compare fares, vote, lock the winner, then everyone books.' },
] as const

function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-heading" className="border-y border-border bg-card">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-20">
        <h2 id="how-heading" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Three stops to a plan
        </h2>
        <ol className="relative mt-10 grid gap-8 md:grid-cols-3 md:gap-6">
          {/* The itinerary line the stops sit on. */}
          <span aria-hidden className="absolute left-[11px] top-3 bottom-3 border-l-2 border-dashed border-border md:left-3 md:right-3 md:top-[11px] md:bottom-auto md:border-l-0 md:border-t-2" />
          {STEPS.map((s) => (
            <li key={s.n} className="relative flex gap-4 md:flex-col md:gap-5">
              <span aria-hidden className="relative z-10 mt-0.5 h-6 w-6 shrink-0 rounded-full border-2 border-foreground bg-card" />
              <div>
                <p className="font-mono text-xs text-muted-foreground">{s.n}</p>
                <h3 className="mt-1 text-lg font-semibold">{s.title}</h3>
                <p className="mt-1 text-muted-foreground">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

function Differentiators() {
  return (
    <section aria-labelledby="diff-heading" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
      <h2 id="diff-heading" className="max-w-2xl font-display text-3xl font-semibold tracking-tight sm:text-4xl">
        Built for the group, not one person typing.
      </h2>

      <div className="mt-12 flex flex-col gap-16 md:gap-24">
        <FeatureRow
          icon={<Lock className="h-4 w-4" aria-hidden />}
          label="Private budgets"
          title="Set your limit without saying it out loud."
          body="Your budget stays on your screen. The group sees a check mark. The “fits everyone” badge waits for three budgets, so nobody is singled out."
          visual={<BudgetVisual />}
        />
        <FeatureRow
          reverse
          icon={<BellRing className="h-4 w-4" aria-hidden />}
          label="Daily fare watch"
          title="Prices move. Your shortlist gets checked every morning."
          body="A real drop in the group total emails everyone. Your fare dipping under your budget emails only you."
          visual={<WatchVisual />}
        />
        <FeatureRow
          icon={<PlaneLanding className="h-4 w-4" aria-hidden />}
          label="Arrival alignment"
          title="Nobody waits six hours at baggage claim."
          body="The Together ranking favors cities where everyone lands close together."
          visual={<ArrivalVisual />}
        />
      </div>
    </section>
  )
}

function FeatureRow({
  icon,
  label,
  title,
  body,
  visual,
  reverse,
}: {
  icon: ReactNode
  label: string
  title: string
  body: string
  visual: ReactNode
  reverse?: boolean
}) {
  return (
    <article className={`flex flex-col gap-8 md:items-center md:gap-14 ${reverse ? 'md:flex-row-reverse' : 'md:flex-row'}`}>
      <div className="flex-1">
        <p className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-primary">
          {icon}
          {label}
        </p>
        <h3 className="mt-3 font-display text-2xl font-semibold leading-snug sm:text-3xl">{title}</h3>
        <p className="mt-3 max-w-md text-muted-foreground">{body}</p>
      </div>
      <div className="flex-1">{visual}</div>
    </article>
  )
}

function BudgetVisual() {
  const crew = [
    { name: 'Maya', home: 'SEA' },
    { name: 'Jonah', home: 'BOS' },
    { name: 'Priya', home: 'MIA' },
  ]
  return (
    <div aria-hidden className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <ul className="divide-y divide-border">
        {crew.map((c) => (
          <li key={c.name} className="flex items-center justify-between gap-3 py-3">
            <span className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-sm font-medium">
                {c.name[0]}
              </span>
              <span className="font-medium">{c.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{c.home}</span>
            </span>
            <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">budget set ✓</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center justify-between rounded-xl bg-muted px-4 py-3">
        <span className="inline-flex items-center gap-2 text-sm">
          <Lock className="h-4 w-4" /> Your budget, only you see it
        </span>
        <span className="font-mono text-sm font-medium">$420</span>
      </div>
    </div>
  )
}

function WatchVisual() {
  return (
    <div aria-hidden className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-baseline justify-between">
        <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">BNA · group total</p>
        <p className="font-mono text-xs text-success">−$84 since Monday</p>
      </div>
      <svg viewBox="0 0 300 90" className="mt-3 h-24 w-full">
        <polyline
          points="0,22 50,18 100,26 150,20 200,40 250,58 300,70"
          className="fill-none stroke-foreground"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={300} cy={70} r={4} className="fill-primary" transform="translate(-4 0)" />
      </svg>
      <div className="mt-3 rounded-xl border border-border bg-background px-4 py-3 text-sm">
        <p className="font-medium">Your Nashville trip got cheaper</p>
        <p className="mt-0.5 text-muted-foreground">
          Group total <span className="font-mono">$702 → $618</span>. Your fare: <span className="font-mono">$198</span>.
        </p>
      </div>
    </div>
  )
}

function ArrivalVisual() {
  // One lane per traveler on a 6 AM–midnight axis; the shaded window spans first to last arrival.
  const arrivals = [
    { code: 'MIA', time: '4:10 PM', h: 16 + 10 / 60 },
    { code: 'BOS', time: '5:05 PM', h: 17 + 5 / 60 },
    { code: 'SEA', time: '5:50 PM', h: 17 + 50 / 60 },
  ]
  const at = (h: number) => ((h - 6) / 18) * 100
  const first = at(arrivals[0].h)
  const last = at(arrivals[arrivals.length - 1].h)
  return (
    <div aria-hidden className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Friday · landing in BNA</p>
      <div className="mt-4 grid grid-cols-[3rem_1fr_4.5rem] items-center gap-x-3 gap-y-3">
        {arrivals.map((a) => (
          <div key={a.code} className="contents">
            <span className="font-mono text-xs font-medium">{a.code}</span>
            <div className="relative h-6">
              <div className="absolute inset-y-0 rounded bg-primary/15" style={{ left: `${first}%`, width: `${last - first}%` }} />
              <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-border" />
              <div
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
                style={{ left: `${at(a.h)}%` }}
              />
            </div>
            <span className="text-right font-mono text-xs text-muted-foreground">{a.time}</span>
          </div>
        ))}
        <span />
        <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
          <span>6a</span>
          <span>noon</span>
          <span>6p</span>
          <span>12a</span>
        </div>
        <span />
      </div>
      <p className="mt-4 inline-flex rounded-full bg-secondary px-3 py-1 text-sm font-medium">Everyone lands within 1h 40m</p>
    </div>
  )
}

function CallToAction() {
  return (
    <section className="bg-foreground text-background">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-16 sm:px-6 md:flex-row md:items-center md:justify-between md:py-20">
        <div>
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Settle the group chat.
          </h2>
          <p className="mt-2 max-w-md opacity-80">Planning alone? Add two ghost travelers and try the whole flow.</p>
        </div>
        <Link
          to="/trips"
          className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-background"
        >
          Start a trip <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </section>
  )
}
