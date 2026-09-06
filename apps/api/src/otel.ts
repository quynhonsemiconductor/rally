/**
 * OpenTelemetry bootstrap for the API — must be the very first import in main.ts,
 * so auto-instrumentation patches HTTP, pg, ioredis and the AWS SDK before any
 * module loads them.
 *
 * The implementation is shared with the worker; see
 * the `@quynhonsemiconductor/observability` package. Imported from its `/otel` subpath rather
 * than the package root on purpose: the root barrel reaches Nest and pino, which
 * would then be required *before* instrumentation is installed.
 *
 * Shutdown: call `shutdownOtel()` from the main.ts signal handler BEFORE
 * `app.close()`. Do NOT register a second SIGTERM handler here — main.ts owns the
 * shutdown sequence.
 */
import { startOtel, shutdownOtel } from '@quynhonsemiconductor/observability/otel';

export { shutdownOtel };

/**
 * Explicit bucket boundaries for `http.server.duration`, in milliseconds.
 *
 * WHY THIS IS SET AT ALL. The OTel JS default explicit-histogram boundaries stop at
 * 10000 (`[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]`),
 * and `histogram_quantile` clamps to the largest finite boundary. So the p99 alert
 * that paged with the value "10 seconds" was really reporting "somewhere above 10
 * seconds" — a 12s request and a 240s one produced the identical number, and the whole
 * class of request this file's neighbouring fixes are about (a storage call under a
 * multi-minute resilience budget that still answers 200) was arithmetically invisible.
 *
 * THE LOW END IS THE OTEL DEFAULT, VERBATIM, up to and including 10000. Two reasons.
 * The healthy p99 is a measured ~48ms, which sits inside the default's 25/50/75 run
 * and is therefore resolved exactly as well as before — the point of widening the top
 * is to see the tail, not to trade away resolution where the service actually lives.
 * And every existing dashboard panel and recording rule was built on these
 * boundaries; keeping the shared prefix means only the new upper buckets are new
 * series, instead of every bucket shifting underneath a query nobody remembers
 * writing.
 *
 * THE FOUR ADDED BOUNDARIES EACH BRACKET A BUDGET THAT REALLY EXISTS on the request
 * path, so a clamped p99 now names a suspect instead of a ceiling:
 *
 *   15000, 30000  bracket the DATABASE preset's worst case. `timeout: 5_000` with
 *                 `retry.maxAttempts: 3` is FOUR executions, because cockatiel's
 *                 maxAttempts counts retries (`RetryPolicy.js`: `retries <
 *                 this.options.maxAttempts`), so ~20.7s including backoff.
 *   60000         is the ALB's idle timeout. `infra/modules/stack` sets no
 *                 `idle_timeout` on `aws_lb`, so the AWS default of 60s applies, and
 *                 that makes this boundary a semantic line rather than a round
 *                 number: past it the client connection is already gone and the
 *                 server is doing work for nobody. A p99 that crosses 60000 is a
 *                 different incident from one that reaches 30000.
 *   120000,       bracket the widest budget still reachable from a request:
 *   180000        EXTERNAL_API at `timeout: 30_000` x 4 executions ≈ 120.7s. The top
 *                 finite boundary is deliberately ABOVE every budget the application
 *                 can produce, so the overflow bucket means "something outside our
 *                 own timeouts" — a stuck socket, a paused container — rather than
 *                 "one of the timeouts we already know about".
 *
 * The STORAGE_INTERACTIVE preset added alongside this (~6.1s worst case for the
 * attachment-confirm HEAD) needs no new boundary: the default 5000/7500 pair already
 * brackets it, which is part of why 3s x 2 attempts was chosen for it.
 */
const HTTP_DURATION_BOUNDARIES_MS = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1_000, 2_500, 5_000, 7_500, 10_000, 15_000, 30_000,
  60_000, 120_000, 180_000,
];

startOtel({
  defaultServiceName: 'rova-api',
  httpDurationBoundaries: HTTP_DURATION_BOUNDARIES_MS,
});
