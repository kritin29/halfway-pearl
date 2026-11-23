/**
 * A stable color per traveler, so the same person has the same avatar color
 * on Crew, Results and Book. Keyed on the traveler id (not the display name,
 * which can change). Display only.
 */
export const PERSON_HUES = ['navy', 'terracotta', 'slate', 'pine', 'plum', 'ochre'] as const
export type PersonHue = (typeof PERSON_HUES)[number]

export function personHue(id: string): PersonHue {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return PERSON_HUES[h % PERSON_HUES.length]
}

/** First letter for the avatar, uppercased; "?" for an empty name. */
export function initial(name: string | null | undefined): string {
  const c = (name ?? '').trim()[0]
  return c ? c.toUpperCase() : '?'
}
