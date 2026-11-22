/**
 * The product name people see (titles, nav). `APP_NAME` in constants.ts stays
 * the app slug. Kept in its own module, free of SDK imports, so static pages
 * (landing, 404) can use it without pulling the DeepSpace client chunk.
 */
export const BRAND = 'Halfway'

/** `<title>` text for a page: "Your trips · Halfway". */
export function pageTitle(page?: string): string {
  return page ? `${page} · ${BRAND}` : BRAND
}
