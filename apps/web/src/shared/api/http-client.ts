/**
 * Typed HTTP client — wraps openapi-fetch for the same-origin BFF auth model.
 * All API calls go through here; never call fetch() directly.
 *
 * Auth model: the browser holds NO tokens. Requests carry the
 * `__Host-rova_session` cookie (sent automatically via `credentials: 'include'`),
 * and the API's shared guard resolves + refreshes the underlying access token
 * server-side. A 401 therefore means the session is genuinely dead.
 */
import { notify } from '@/shared/lib/toast'
import createClient from 'openapi-fetch'
import type { paths } from './generated/api'
import { ENV } from '@/shared/config/env'
import { CSRF_HEADER, getCsrfToken } from './csrf'

const BASE_URL = ENV.API_BASE_URL

// ── Base client ──────────────────────────────────────────────────────────────
/**
 * What a 403 should DO, as a pure function so the rule is testable without touching `window`.
 *
 * `'toast'` for a refused WRITE — nothing on screen changed, so silence would read as success.
 * `'silent'` for everything else: a refused READ belongs to the surface that asked for it (the route
 * guard renders `AccessDenied`, a feed's `isError` renders `LoadErrorState` or an absent value), and
 * `/auth/*` renders its own inline error on the login form.
 *
 * Note what is NOT here: navigation. See the middleware below for why.
 */
export function forbiddenAction(status: number, method: string, url: string): 'toast' | 'silent' {
  if (status !== 403) return 'silent'
  if (url.includes('/auth/')) return 'silent'
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? 'silent' : 'toast'
}

export const apiClient = createClient<paths>({
  baseUrl: BASE_URL,
  credentials: 'include',
})

// ── Request middleware: OTel trace correlation ───────────────────────────────
apiClient.use({
  async onRequest({ request }) {
    // W3C traceparent for OTel correlation. crypto.randomUUID() needs a secure
    // context (HTTPS/localhost) — skip in plain-HTTP dev.
    if (typeof crypto.randomUUID === 'function') {
      const traceId = crypto.randomUUID().replace(/-/g, '')
      const spanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      request.headers.set('traceparent', `00-${traceId}-${spanId}-01`)
    }

    // CSRF: the session cookie rides along ambiently, so every state-changing
    // request must also present the token only this origin's JS can read.
    const csrfToken = getCsrfToken()
    if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
      request.headers.set(CSRF_HEADER, csrfToken)
    }
    return request
  },

  /**
   * Response middleware: a 401 is a SESSION fact, a 403 is a REQUEST fact.
   *
   * 401 navigates, because there is no session left to render anything with. 403 does NOT, and that
   * is the correction: this used to do `window.location.href = '/403'` for EVERY refused request,
   * including the background ones. A picker feed the reader never asked for — an owner roster, a
   * release list, a milestone lookup — would evict them from a page they legitimately own, mid-edit,
   * with a full page load. Under the per-project access model that is not an edge case: an Editor
   * holds most delivery codes and lacks the administrative ones, so the surfaces they own routinely
   * fan out one request they may not make. It also defeated every absent-versus-error state in the
   * app, because the navigation won the race against the render.
   *
   * So a refused READ is left to its own surface, which is the only thing that knows what the answer
   * was for: the route guard renders `AccessDenied` for a surface the reader may not open, and a
   * feed's own `isError` renders `LoadErrorState` or an absent value. A refused WRITE is different —
   * nothing on screen changed, so silence would read as success — and it gets a toast here, in the
   * one place that still knows the status code. Feature hooks throw plain `Error`s built by
   * `apiErrorMessage`, so the status is gone by the time a mutation's `onError` sees it; this
   * middleware is the last point where 403 is distinguishable from any other failure.
   *
   * `/auth/*` is exempt: the login form renders its own inline error.
   */
  async onResponse({ request, response }) {
    if (response.status === 401) {
      // The shared guard refreshes the session's access token server-side, so a
      // 401 means the session is truly dead — send the user to login, keeping
      // the current page as returnTo.
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search)
      window.location.href = `/login?returnTo=${returnTo}`
    }

    if (forbiddenAction(response.status, request.method, request.url) === 'toast') {
      // The i18n singleton is imported LAZILY, inside the branch. This file is outside React so it
      // cannot use `useTranslation`, but a top-level import would pull i18n into the module graph of
      // everything that touches the API client — which INITIALISES it as a side effect, so `t()`
      // starts returning real copy in tests that were written against the key. That is not a
      // hypothetical: it broke an unrelated release-panel test the moment the import went in.
      const { default: i18n } = await import('@/shared/i18n/i18n')
      notify.error(i18n.t('common:permissionDenied.write'))
    }

    return response
  },
})
