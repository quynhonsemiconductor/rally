/**
 * Shared helpers for email dispatch.
 *
 * FROM-address resolution is used by `EmailService` alone — it resolves `from` ONCE,
 * centrally, and passes it explicitly on every `provider.send()` call. Providers no
 * longer resolve or fall back to a from-address themselves; each just throws when
 * `payload.from` is absent (see resend.provider.ts / ses.provider.ts). Header-building
 * (`buildUnsubscribeHeaders`) stays here since it is still per-provider.
 */
import type { AppConfigService } from '../../config/app-config.service';
import type { EmailCategory } from '../email.provider';

/**
 * Resolve the verified sender address from config.
 */
export function resolveFromEmail(config: AppConfigService): string {
  return config.get('MAIL_FROM_EMAIL') ?? '';
}

/**
 * Build the RFC 5322 "Display Name <address>" From header value.
 * Using a display name is required for anti-spam compliance — bare addresses
 * score lower with Gmail's spam filters.
 *
 *   buildFromAddress(config)  →  "Mini Rally <noreply@app.example.com>"
 */
export function buildFromAddress(config: AppConfigService): string {
  const email = resolveFromEmail(config);
  const name = (config.get('MAIL_FROM_NAME') as string | undefined) ?? 'Mini Rova';
  return `"${name}" <${email}>`;
}

/**
 * Build RFC 2369 + RFC 8058 anti-spam headers based on email category.
 *
 * Rules:
 *   transactional — NO List-Unsubscribe (not required; adding it can hurt
 *                   deliverability by marking 1:1 transactional mail as bulk).
 *   notification  — List-Unsubscribe + List-Unsubscribe-Post (user can opt out).
 *   marketing     — Same as notification, plus Precedence: bulk.
 *
 * Google/Yahoo 2024 require one-click unsubscribe for bulk senders (>5 000
 * messages/day to Gmail).  For Phase 0 volumes this is future-proofing, but
 * the infrastructure is ready.
 */
export function buildUnsubscribeHeaders(
  category: EmailCategory,
  appBaseUrl: string,
): Record<string, string> {
  if (category === 'transactional') return {};

  const domain = new URL(appBaseUrl).hostname;
  const headers: Record<string, string> = {
    'List-Unsubscribe': `<mailto:unsubscribe@${domain}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  if (category === 'marketing') {
    headers['Precedence'] = 'bulk';
  }
  return headers;
}
