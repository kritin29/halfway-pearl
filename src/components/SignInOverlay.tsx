/**
 * The SDK's sign-in overlay with Halfway's wording. DeepSpace has no email
 * sign-up: accounts come from Google or GitHub, and the first sign-in creates
 * the account. The overlay's "Sign in with email" is only for existing
 * email/password accounts (the platform's test accounts) and has no prop to
 * hide it, so the description says plainly how a new person gets in.
 */
import { AuthOverlay } from 'deepspace'
import { BRAND } from '@/brand'

export function SignInOverlay({ onClose }: { onClose: () => void }) {
  return (
    <AuthOverlay
      onClose={onClose}
      title={`Sign in to ${BRAND}`}
      description="New here? Continue with Google or GitHub. Your account is created the first time you sign in. Email sign-in is only for existing email accounts."
    />
  )
}
