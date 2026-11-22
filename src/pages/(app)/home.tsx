/* home pattern: search-first — Halfway's home is the trips list at /trips; /home only forwards there. */
/**
 * /home stays as a route because the sign-in callback (src/server/http-routes.ts)
 * and older links land here. The app's real home is /trips.
 */
import { Navigate } from 'react-router-dom'

export default function HomePage() {
  return <Navigate to="/trips" replace />
}
