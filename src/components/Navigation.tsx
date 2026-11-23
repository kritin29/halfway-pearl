/**
 * Top nav: the Halfway wordmark, nav.ts links (just "Trips"), sign-in via
 * <AuthOverlay>, and sign-out. With one link there's no mobile menu; the
 * link stays visible at every width. Keep the data-testid hooks
 * (`app-navigation`, `nav-sign-in-button`, `nav-user-name`, `nav-user-email`)
 * — the shipped tests rely on them. `nav-user-email` is the one that carries
 * an identity the test can check exactly: a display name is optional, the
 * email is the credential the session was opened with.
 */

import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AuthOverlay, useAuthProfileReady, signOut } from 'deepspace'
import { ChevronDown, LogOut } from 'lucide-react'
import { BRAND } from '../brand'
import type { Role } from '../constants'
import { nav } from '../nav'
import { cn } from '../lib/utils'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui'

export default function Navigation() {
  const { isLoaded, isSignedIn, user, userLoading } = useAuthProfileReady({ requireUser: true })
  const location = useLocation()
  const [showAuthModal, setShowAuthModal] = useState(false)

  const profileReady = !isSignedIn || (!userLoading && !!user)
  const userRole = (user?.role ?? 'anonymous') as Role | 'anonymous'

  const visibleNav = nav.filter((item) => {
    if (item.devOnly && !import.meta.env.DEV) return false
    if (!item.roles) return true
    if (!profileReady) return false
    if (userRole === 'admin') return true
    return item.roles.includes(userRole as Role)
  })

  const navLink = (item: (typeof nav)[number]) => {
    // A trip page (/t/…) or invite (/join/…) lives under "Trips".
    const active =
      location.pathname.startsWith(item.path) ||
      (item.path === '/trips' && /^\/(t|join)\//.test(location.pathname))
    return (
      <Link
        key={item.path}
        to={item.path}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors duration-150',
          active
            ? 'bg-white/12 text-nav-foreground after:absolute after:inset-x-3 after:-bottom-[11px] after:h-0.5 after:rounded-full after:bg-coral'
            : 'text-nav-muted hover:bg-white/8 hover:text-nav-foreground',
        )}
      >
        {item.label}
      </Link>
    )
  }

  return (
    <>
      <nav data-testid="app-navigation" aria-label="Main" className="bg-nav text-nav-foreground shadow-[0_1px_0_rgba(255,255,255,0.06),0_8px_24px_-12px_rgba(26,22,54,0.5)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Link
            to="/trips"
            className="group mr-1 inline-flex items-center gap-2 rounded-lg text-nav-foreground"
            aria-label={`${BRAND}, your trips`}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6 transition-transform duration-200 motion-safe:group-hover:-translate-y-0.5"
              aria-hidden
            >
              <path d="M2 20 Q7 9 12 11" className="fill-none stroke-nav-muted" strokeWidth={1.6} strokeDasharray="2 2" />
              <path d="M22 20 Q17 9 12 11" className="fill-none stroke-nav-muted" strokeWidth={1.6} strokeDasharray="2 2" />
              <circle cx={12} cy={9} r={4} className="fill-coral" />
              <circle cx={12} cy={9} r={1.4} className="fill-nav" />
            </svg>
            <span className="font-display text-lg font-semibold tracking-tight">{BRAND}</span>
          </Link>

          <div className="flex items-center">{visibleNav.map(navLink)}</div>

          <div className="flex-1" />

          {!isLoaded ? null : isSignedIn && !profileReady ? (
            /* Signed in, profile still loading — skeleton pill, never the
               Sign in button (that would offer sign-in to a signed-in user). */
            <div className="flex items-center gap-2 rounded-full border border-white/15 bg-white/8 py-1 pl-1 pr-2.5">
              <div className="h-6 w-6 animate-pulse rounded-full bg-white/20" />
              <div className="hidden h-4 w-20 animate-pulse rounded-md bg-white/20 sm:block" />
            </div>
          ) : isSignedIn && user ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    aria-label="Account menu"
                    className="group flex cursor-pointer items-center gap-2 rounded-full border border-white/15 bg-white/8 py-1 pl-1 pr-2.5 text-sm transition-colors hover:border-white/30 hover:bg-white/15 data-[popup-open]:bg-white/15"
                  >
                    <Avatar className="h-6 w-6 ring-2 ring-coral">
                      <AvatarImage src={user.imageUrl ?? undefined} referrerPolicy="no-referrer" />
                      <AvatarFallback className="bg-coral text-[11px] font-semibold text-nav">
                        {(user.name?.[0] ?? user.email?.[0] ?? '?').toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span
                      data-testid="nav-user-name"
                      className="hidden max-w-[140px] truncate font-medium text-nav-foreground sm:inline"
                    >
                      {user.name || user.email}
                    </span>
                    <ChevronDown
                      className="h-3.5 w-3.5 text-nav-muted transition-transform duration-150 group-data-[popup-open]:rotate-180"
                      aria-hidden
                    />
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="truncate font-medium text-foreground">
                    {user.name || 'Signed in'}
                  </div>
                  <div
                    data-testid="nav-user-email"
                    className="truncate text-xs font-normal text-muted-foreground"
                  >
                    {user.email}
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => signOut()}>
                  <LogOut aria-hidden />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <button
              data-testid="nav-sign-in-button"
              onClick={() => setShowAuthModal(true)}
              className="cursor-pointer rounded-lg bg-coral px-3.5 py-1.5 text-sm font-semibold text-nav transition-colors hover:bg-sun"
            >
              Sign in
            </button>
          )}
        </div>
      </nav>

      {showAuthModal && <AuthOverlay onClose={() => setShowAuthModal(false)} />}
    </>
  )
}
