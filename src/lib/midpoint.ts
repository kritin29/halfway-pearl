/**
 * "Geographic middle" hubs (SPEC §3.4, §6 addMidpointHubs). Pure and unit-tested.
 *
 * 1. Each traveler's home airports are averaged into one point, so a traveler
 *    with three airports doesn't count three times.
 * 2. The travelers' points are averaged on the sphere (3-D vector mean), which
 *    also behaves across the antimeridian.
 * 3. The nearest `major` airports to that centroid (haversine distance) are
 *    returned, skipping existing candidates and the travelers' own home airports.
 */
export interface Airport {
  iata: string
  city: string
  country: string
  lat: number
  lon: number
  major: boolean
}

export interface LatLon {
  lat: number
  lon: number
}

const EARTH_RADIUS_KM = 6371.0088

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Spherical centroid of points. Returns null for an empty list or antipodal cancellation. */
export function centroid(points: readonly LatLon[]): LatLon | null {
  if (points.length === 0) return null
  let x = 0
  let y = 0
  let z = 0
  for (const p of points) {
    const lat = toRad(p.lat)
    const lon = toRad(p.lon)
    x += Math.cos(lat) * Math.cos(lon)
    y += Math.cos(lat) * Math.sin(lon)
    z += Math.sin(lat)
  }
  x /= points.length
  y /= points.length
  z /= points.length
  const hyp = Math.sqrt(x * x + y * y)
  if (hyp < 1e-9 && Math.abs(z) < 1e-9) return null
  return { lat: toDeg(Math.atan2(z, hyp)), lon: toDeg(Math.atan2(y, x)) }
}

/**
 * Centroid of the travelers, one point per traveler.
 *
 * @param travelerHomes each traveler's home IATA codes, e.g. [['ORD','MDW'], ['BOS']]
 * @param airports      the airport list (src/data/airports.json)
 * Unknown codes are ignored; travelers with no known airport are skipped.
 */
export function travelersCentroid(
  travelerHomes: readonly (readonly string[])[],
  airports: readonly Airport[],
): LatLon | null {
  const byIata = indexAirports(airports)
  const points: LatLon[] = []
  for (const homes of travelerHomes) {
    const known = homes.map((c) => byIata.get(c.toUpperCase())).filter((a): a is Airport => !!a)
    const point = centroid(known)
    if (point) points.push(point)
  }
  return centroid(points)
}

export interface MidpointHub {
  airport: Airport
  distanceKm: number
}

/**
 * The `n` nearest major airports to the travelers' centroid, excluding
 * existing candidates and anyone's home airport.
 */
export function nearestMajorHubs(
  travelerHomes: readonly (readonly string[])[],
  airports: readonly Airport[],
  options: { n?: number; exclude?: readonly string[] } = {},
): MidpointHub[] {
  const n = options.n ?? 2
  const center = travelersCentroid(travelerHomes, airports)
  if (!center || n <= 0) return []
  const skip = new Set(
    [...(options.exclude ?? []), ...travelerHomes.flat()].map((c) => c.toUpperCase()),
  )
  return airports
    .filter((a) => a.major && !skip.has(a.iata))
    .map((airport) => ({ airport, distanceKm: haversineKm(center, airport) }))
    .sort((a, b) => a.distanceKm - b.distanceKm || a.airport.iata.localeCompare(b.airport.iata))
    .slice(0, n)
}

function indexAirports(airports: readonly Airport[]): Map<string, Airport> {
  return new Map(airports.map((a) => [a.iata, a]))
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI
}
