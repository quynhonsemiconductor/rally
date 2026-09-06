/**
 * SesEmailProvider — production AWS SES transport (v2 API).
 *
 * Requires:
 *  MAIL_FROM_EMAIL                      — verified sender address
 *  MAIL_FROM_NAME                       — display name, e.g. "Mini Rova"
 *  AWS_REGION                           — e.g. ap-southeast-1
 *  IAM role / env creds with ses:SendEmail
 *  SES_BOUNCE_CONFIGSET (optional)      — configuration set name; when set, every send is
 *                                          tagged with it so bounce/complaint events fan out
 *                                          to the feedback queue BounceFeedbackService drains.
 *                                          Empty = sends still work, just unattributable to a
 *                                          row later — the pre-feedback-loop behaviour.
 *
 * WHY sesv2 AND NOT the older client-ses: the v2 SendEmailCommand carries
 * ConfigurationSetName and returns MessageId as a first-class field, and MessageId is the
 * ONLY exact way to match an asynchronous bounce notification back to the row that sent
 * it (SES echoes it as `mail.messageId` in every event). Address-plus-timestamp matching
 * would misattribute a re-invite to the earlier attempt; the id cannot.
 *
 * Anti-spam / Google-Yahoo 2024 compliance:
 *  - Proper "Display Name <address>" From header → avoids spam filters.
 *  - HTML + plain-text always paired → higher deliverability score.
 *  - SPF/DKIM/DMARC: configured at the domain level in SES + DNS (see infra/live/_shared).
 *  - List-Unsubscribe for marketing/notification categories: buildUnsubscribeHeaders.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { AppConfigService } from '../../config/app-config.service';
import { buildAwsClientConfig } from '../../aws';
import type { IEmailProvider, EmailPayload, EmailSendResult } from '../email.provider';

@Injectable()
export class SesEmailProvider implements IEmailProvider {
  private readonly logger = new Logger(SesEmailProvider.name);
  private readonly ses: SESv2Client;
  private readonly replyTo: string | undefined;
  private readonly configSetName: string | undefined;

  constructor(private readonly config: AppConfigService) {
    this.replyTo = config.get('MAIL_REPLY_TO');
    this.configSetName =
      (config.get('SES_BOUNCE_CONFIGSET') as string | undefined)?.trim() || undefined;

    this.ses = new SESv2Client(buildAwsClientConfig(config));
  }

  async send(payload: EmailPayload): Promise<EmailSendResult> {
    if (!payload.from) {
      /*
       * NO HARD-CODED FALLBACK SENDER, and no silent provider-level default either.
       * `EmailService` always supplies `from` from configuration, and the env schema
       * refuses to boot a non-dev provider without one. With SES this would fail
       * LOUDER than a plain throw — an unverified identity is rejected outright — but
       * that message would name the wrong problem, so the refusal stays here where it
       * can name the actual missing variable.
       */
      throw new Error('SES: no sender address configured (MAIL_FROM_EMAIL)');
    }

    const category = payload.category ?? 'transactional';
    const replyToAddresses = payload.replyTo
      ? [payload.replyTo]
      : this.replyTo
        ? [this.replyTo]
        : [];

    try {
      const result = await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: payload.from,
          ...(replyToAddresses.length > 0 ? { ReplyToAddresses: replyToAddresses } : {}),
          Destination: { ToAddresses: [payload.to] },
          ...(this.configSetName ? { ConfigurationSetName: this.configSetName } : {}),
          Content: {
            Simple: {
              Subject: { Data: payload.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: payload.html, Charset: 'UTF-8' },
                Text: { Data: payload.text, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
      this.logger.log({ to: payload.to, subject: payload.subject, category }, 'Email sent via SES');

      // ACCEPTED, not delivered: SES answers before the receiving server has spoken. The
      // id is what ties this acceptance to the verdict that may arrive minutes later.
      return { messageId: result.MessageId ?? null };
    } catch (err) {
      this.logger.error({ err, to: payload.to, subject: payload.subject }, 'SES send failed');
      throw err;
    }
  }
}
