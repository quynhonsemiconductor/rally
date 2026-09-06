// `.env` FIRST, above the OTel bootstrap: that bootstrap reads process.env directly, and
// @nestjs/config does not load the file until ConfigModule initialises — far too late.
// See libs/platform/src/config/load-env.ts.
import '@platform/config/load-env';
// OTel must be bootstrapped BEFORE any other imports so auto-instrumentation patches modules
import { shutdownOtel } from './otel';

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { bootstrapApp } from './bootstrap/app.bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Disable Fastify's built-in logger — pino handles all logging
      logger: false,
      // Trust X-Forwarded-For from ALB
      trustProxy: true,
    }),
    // rawBody: preserve the exact request bytes on req.rawBody so the SCM
    // webhook controller can verify GitHub's X-Hub-Signature-256 HMAC.
    { bufferLogs: true, rawBody: true },
  );

  await bootstrapApp(app);

  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  await app.listen(port, host);

  const logger = app.get(Logger);
  logger.log(`🚀 API listening on ${host}:${port} [${process.env['NODE_ENV']}]`, 'Bootstrap');

  // ── Process signal handlers ────────────────────────────────────────────────
  // ECS sends SIGTERM on task replacement; Docker Ctrl-C sends SIGINT.
  // app.close() triggers OnModuleDestroy hooks: DB pool drain, Valkey quit, etc.
  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal} — shutting down gracefully…`, 'Bootstrap');
    try {
      // Flush and shut down OTEL before NestJS closes (drains pending spans)
      await shutdownOtel();
      await app.close();
      logger.log('Shutdown complete', 'Bootstrap');
    } catch (err) {
      logger.error({ msg: 'Error during shutdown', err }, 'Bootstrap');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  // Log unhandled rejections without crashing (they surface via normal paths)
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ msg: 'Unhandled promise rejection', reason }, 'Bootstrap');
  });

  // Uncaught exceptions leave process in unknown state — log then exit
  process.on('uncaughtException', (error: Error) => {
    logger.error({ msg: 'Uncaught exception', error }, 'Bootstrap');
    process.exit(1);
  });
}

void bootstrap();


