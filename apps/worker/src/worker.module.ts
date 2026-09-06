import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { createLoggerOptions } from '@quynhonsemiconductor/observability';
import { AppConfigService } from '@platform/config';
import { PlatformModule } from '@platform';
import { AuditModule } from '@modules/audit';
import { NotificationsModule } from '@modules/notifications';
import { ReportingModule } from '@modules/reporting';
import { ScmModule } from '@modules/scm';
import { EntraGuestInviteClient } from '@modules/workspace';
import { EntraGuestInviteRelayService } from './identity/entra-guest-invite-relay.service';
import { AuditProjectionRelay } from './audit/audit-projection.relay';
import { SnapshotCronService } from './cron/snapshot.cron';
import { CleanupCronService } from './cron/cleanup.cron';
import { EmailRelayService } from './email/email-relay.service';
import { ApiTokensModule } from '@modules/api-tokens';
import { BounceFeedbackService } from './email/bounce-feedback.service';
import { NotificationRelayService } from './notifications/notification-relay.service';
import { ScmWebhookRelayService } from './scm/scm-webhook-relay.service';
import { ScmBackfillRelayService } from './scm/scm-backfill-relay.service';

/**
 * Worker process module.
 * Imports only the bounded contexts that have relays or cron jobs.
 * Shares all platform infrastructure (DB, cache, outbox relay) with the API process.
 */
@Module({
  imports: [
    // Same shared factory as the API. The worker's own copy of this block had
    // drifted and was missing the `redact` list entirely, so a logged SDK error
    // could have written credentials to CloudWatch.
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createLoggerOptions({
          serviceName: 'rova-worker',
          nodeEnv: config.get('NODE_ENV'),
          serviceVersion: config.get('SERVICE_VERSION'),
          level: config.get('LOG_LEVEL'),
          pretty: config.get('LOG_PRETTY'),
        }),
    }),
    ScheduleModule.forRoot(),
    PlatformModule,

    // `WorkspaceService` (reached transitively through the module graph) injects
    // `ApiTokensService` to revoke tokens on member removal, and the module is @Global — but a
    // @Global module still has to be INSTANTIATED somewhere in the process. The API's root module
    // imports it; the worker resolved it only by module-init order, and inserting
    // EmailDeliveryService into the same constructor flipped that order and crash-looped the
    // worker at boot ("ApiTokensService at index [12]"). Import it here so the worker says what it
    // needs instead of relying on the graph's incidental shape.
    ApiTokensModule,

    // Contexts with relays / cron jobs
    AuditModule,
    NotificationsModule,
    ReportingModule,
    ScmModule,
  ],
  providers: [
    // Transactional outbox → audit_logs projection
    AuditProjectionRelay,
    // Email outbox relay → IEmailProvider
    EmailRelayService,
    BounceFeedbackService,
    // Notification outbox relay → in_app_notifications
    NotificationRelayService,
    // SCM webhook inbox relay → connections/changesets
    ScmWebhookRelayService,
    // SCM backfill jobs relay → GitHub App REST → connections/changesets
    ScmBackfillRelayService,
    // Entra B2B guest provisioning relay → Microsoft Graph → workspace_invitations
    //
    // The client is registered as a PLAIN PROVIDER rather than by importing WorkspaceModule: its
    // only dependencies (AppConfigService, ResilienceService) are global from PlatformModule, and
    // importing the module would instantiate three HTTP controllers in a process with no HTTP
    // adapter.
    EntraGuestInviteClient,
    EntraGuestInviteRelayService,
    // Scheduled cron jobs
    SnapshotCronService,
    CleanupCronService,
  ],
})
export class WorkerModule {}
