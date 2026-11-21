import { useCallback, useRef, useState } from 'react'
import { callAction, type ActionResponse } from '@/lib/actions-client'

export interface ActionError {
  code: string
  message: string
}

/**
 * Pending/error state around one server action. `run` resolves to the
 * envelope (never throws) and ignores calls while one is in flight, so a
 * double click can't send the same write twice.
 */
export function useAction<T, P extends Record<string, unknown> = Record<string, unknown>>(name: string) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ActionError | null>(null)
  const inFlight = useRef(false)

  const run = useCallback(
    async (params: P): Promise<ActionResponse<T> | null> => {
      if (inFlight.current) return null
      inFlight.current = true
      setPending(true)
      setError(null)
      try {
        const res = await callAction<T>(name, params)
        if (!res.success) setError({ code: res.code, message: res.error })
        return res
      } finally {
        inFlight.current = false
        setPending(false)
      }
    },
    [name],
  )

  const reset = useCallback(() => setError(null), [])
  return { run, pending, error, reset }
}
