/**
 * Theme catalog. Color values live in src/themes.css — this file is metadata
 * only. The active theme is `data-theme` on <html> in index.html.
 */

export const THEMES = [
  {
    id: 'halfway',
    label: 'Halfway',
    description: 'Warm paper, navy ink and a vermilion pin: a route map on a corkboard.',
  },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

/** Read the currently active theme id from <html data-theme>. */
export function getActiveTheme(): ThemeId {
  if (typeof document === 'undefined') return 'halfway'
  const id = document.documentElement.getAttribute('data-theme') as ThemeId | null
  return id ?? 'halfway'
}

/** Look up a theme entry by id, or fall back to the first theme. */
export function getTheme(id: string) {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}
