import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '@platform/config';
import { RequestContextService } from '@platform/context/request-context';
import { createLoggerOptions } from '@quynhonsemiconductor/observability';
import { PlatformModule } from '@platform';
import { IdentityModule } from '@modules/identity';
import { WorkspaceModule } from '@modules/workspace';
import { AccessModule } from '@modules/access';
import { ProjectsModule } from '@modules/projects';
import { WorkItemsModule } from '@modules/work-items';
import { IterationsModule } from '@modules/iterations';
import { ReleasesModule } from '@modules/releases';
import { WorkflowModule } from '@modules/workflow';
import { CollaborationModule } from '@modules/collaboration';
import { NotificationsModule } from '@modules/notifications';
import { AuditModule } from '@modules/audit';
import { ReportingModule } from '@modules/reporting';
import { TeamStatusModule } from '@modules/team-status';
import { MilestonesModule } from '@modules/milestones';
import { PortfolioModule } from '@modules/portfolio';
import { CapacityModule } from '@modules/capacity';
import { QualityModule } from '@modules/quality';
import { ScmModule } from '@modules/scm';
import { ApiTokensModule } from '@modules/api-tokens';
import { GlobalExceptionFilter, REQUEST_CONTEXT } from '@quynhonsemiconductor/platform-http';
import { HttpLoggingInterceptor } from '@platform/http/http-logging.interceptor';
import { ZodValidationPipe } from 'nestjs-zod';
import { SanitizationPipe } from '@platform/pipes/sanitization.pipe';
import { AsyncLocalStorageMiddleware } from '@platform/context/als.middleware';

@Module({
  imports: [
    // Pino structured logging — one shared factory (redaction, trace correlation,
    // ALS business context) lives in @platform so api and worker cannot drift.
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createLoggerOptions({
          serviceName: 'rova-api',
          nodeEnv: config.get('NODE_ENV'),
          serviceVersion: config.get('SERVICE_VERSION'),
          level: config.get('LOG_LEVEL'),
          pretty: config.get('LOG_PRETTY'),
        }),
    }),

    // Platform (config, db, auth, cache, outbox, observability)
    PlatformModule,

    // Bounded contexts
    IdentityModule,
    WorkspaceModule,
    AccessModule,
    ProjectsModule,
    WorkItemsModule,
    IterationsModule,
    ReleasesModule,
    WorkflowModule,
    CollaborationModule,
    NotificationsModule,
    AuditModule,
    ReportingModule,
    TeamStatusModule,
    MilestonesModule,
    PortfolioModule,
    CapacityModule,
    QualityModule,
    ScmModule,
    ApiTokensModule,
  ],
  providers: [
    // Bind the shared filter's request-context port to rally's ALS-backed service.
    { provide: REQUEST_CONTEXT, useExisting: RequestContextService },

    // Global exception filter → stable RFC-9457-style error envelope
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },

    // Global interceptor: structured HTTP access log (replaces pino-http autoLogging)
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },

    // Global pipes — order matters: sanitize XSS BEFORE Zod validates shape
    { provide: APP_PIPE, useClass: SanitizationPipe },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // AsyncLocalStorage middleware — sets correlationId + workspace/user stubs for every request
    consumer.apply(AsyncLocalStorageMiddleware).forRoutes('*path');
  }
}
