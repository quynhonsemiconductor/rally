/**
 * `revokeSession` — end the server-side BFF session and clear local auth state.
 *
 * Extracted from `widgets/app-shell`'s `handleSignOut`, which was the only implementation, because a
 * PAGE now needs it too: `/accept-invitation` refuses a forwarded link with
 * `INVITATION_EMAIL_MISMATCH`, and the only action that helps that reader is signing out and
 * returning to the same link as the invited person. A page cannot import a widget (FSD), so
 * duplicating the POST was the alternative — and a second copy of a security-relevant call that must
 * carry the CSRF header and must clear the store on failure is exactly the drift the shared layer
 * exists to prevent.
 *
 * Deliberately does NOT navigate. Where to go afterwards is the caller's decision: the shell goes to
 * `/login`, the accept page goes to `/login?returnTo=<the invitation link>`.
 *
 * The browser holds no tokens (see `http-client.ts`), so "sign out" is entirely: tell the server to
 * drop the session behind `__Host-rova_session`, then forget the user locally.
 */
import { ENV } from '@/shared/config/env'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { withCsrfHeader } from './csrf'

export async function revokeSession(): Promise<void> {
  try {
    await fetch(`${ENV.API_BASE_URL}/v1/bff/logout`, {
      method: 'POST',
      credentials: 'include',
      referrerPolicy: 'no-referrer',
      headers: withCsrfHeader('POST'),
    })
  } catch {
    // Ignore network errors on sign-out — local state is cleared either way, which is the state the
    // reader asked for. A session left alive server-side expires on its own.
  }
  useAuthStore.getState().clearAuth()
}
