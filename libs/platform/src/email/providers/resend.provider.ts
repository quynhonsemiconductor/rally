/**
 * ResendEmailProvider — production transport via Resend (resend.com).
 *
 * Why Resend for Phase 0:
 *   - Single env var setup (RESEND_API_KEY) vs complex AWS IAM.
 *   - Automatic DKIM signing per domain (configure in Resend dashboard).
 *   - SPF record auto-provided after domain verification.
 *   - Generous free tier (100 emails/day) → $20/mo for 50 000/mo.
 *   - Native idempotency key support — safe to retry on network failure.
 *   - Built-in bounce/complaint webhooks → maintain spam rate < 0.1 %.
 *
 * Requires:
 *   RESEND_API_KEY   — from https://resend.com/api-keys
 *   MAIL_FROM_EMAIL  — verified sender address (must match verified domain)
 *   MAIL_FROM_NAME   — display name, e.g. "Mini Rova"
 *
 * Anti-spam / Google-Yahoo 2024 compliance:
 *   - Proper "Display Name <address>" From header.
 *   - category='transactional': no List-Unsubscribe.
 *   - category='notification'|'marketing': RFC 2369 + RFC 8058 headers.
 *   - DKIM/SPF handled by Resend's infrastructure per your verified domain.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import type { IEmailProvider, EmailPayload, EmailSendResult } from '../email.provider';
import { buildUnsubscribeHeaders } from './shared';

@Injectable()
export class ResendEmailProvider implements IEmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);
  private readonly client: Resend;
  private readonly replyTo: string | undefined;
  private readonly appBaseUrl: string;

  constructor(private readonly config: AppConfigService) {
    const apiKey = config.get('RESEND_API_KEY') as string;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY must be set when EMAIL_PROVIDER=resend');
    }
    this.client = new Resend(apiKey);

    this.replyTo = config.get('MAIL_REPLY_TO');
    this.appBaseUrl = config.get('APP_BASE_URL');
  }

  async send(payload: EmailPayload): Promise<EmailSendResult> {
    if (!payload.from) {
      /*
       * NO HARD-CODED FALLBACK SENDER, and no silent provider-level default either.
       * `EmailService` always supplies `from` from configuration, and the env schema
       * refuses to boot a non-dev provider without one — this is the third line of
       * defence, and it throws rather than guessing at a sender.
       */
      throw new Error('Resend: no sender address configured (MAIL_FROM_EMAIL)');
    }

    const category = payload.category ?? 'transactional';
    const idempotencyKey = payload.idempotencyKey ?? randomUUID();

    const headers: Record<string, string> = {
      'X-Entity-Ref-ID': idempotencyKey,
      ...buildUnsubscribeHeaders(category, this.appBaseUrl),
    };

    try {
      const { data, error } = await this.client.emails.send(
        {
          from: payload.from,
          to: payload.to,
          replyTo: payload.replyTo ?? this.replyTo,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          headers,
          tags: [{ name: 'category', value: category }],
        },
        // Idempotency key passed as second-arg options (Resend SDK v4+).
        { idempotencyKey: idempotencyKey },
      );

      if (error) {
        throw new Error(`Resend error: ${error.message}`);
      }

      this.logger.log(
        { to: payload.to, subject: payload.subject, category, idempotencyKey },
        'Email sent via Resend',
      );

      // Resend's id is what its webhook events carry; with no webhook wired the id is
      // inert, but returning it costs nothing and keeps the provider contract uniform.
      return { messageId: data?.id ?? null };
    } catch (err) {
      this.logger.error({ err, to: payload.to, subject: payload.subject }, 'Resend send failed');
      throw err;
    }
  }
}
