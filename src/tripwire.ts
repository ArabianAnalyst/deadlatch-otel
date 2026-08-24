import { SpanStatusCode } from "@opentelemetry/api";
import { getTracer, DEADLATCH_TRACER } from "./otel.js";
import type { ScanLike, ScanReportLike } from "./types.js";

/**
 * Wrap tripwire's scan() so a run emits one parent `deadlatch.watch` span with
 * the scan summary, plus a child `deadlatch.watch.flag` span for every violated
 * scenario, so each flag is addressable in Grafana. Returns a wrapped scan
 * function with the same signature.
 */
export function instrumentScan(scan: ScanLike, tracerName: string = DEADLATCH_TRACER): ScanLike {
  const tracer = getTracer(tracerName);

  return (entrypoint: unknown, options?: unknown) =>
    tracer.startActiveSpan("deadlatch.watch", async (span) => {
      try {
        const report = (await scan(entrypoint, options)) as ScanReportLike;
        span.setAttribute("deadlatch.leg", "watch");
        span.setAttribute("deadlatch.package", "tripwire");

        const s = report?.summary;
        if (s) {
          span.setAttribute("tripwire.scenarios", Number(s.totalScenarios));
          span.setAttribute("tripwire.violations", Number(s.violatedScenarios));
          span.setAttribute("tripwire.suspicions", Number(s.suspicions));
        }

        for (const raw of report?.scenarios ?? []) {
          const sc = raw as Record<string, unknown>;
          const checks = Array.isArray(sc.checks) ? (sc.checks as Record<string, unknown>[]) : [];
          const violated = checks.some(
            (c) => c && (c.passed === false || c.ok === false || c.violated === true)
          );
          if (violated || sc.ranWithError) {
            const scenario = sc.scenario as Record<string, unknown> | undefined;
            const child = tracer.startSpan("deadlatch.watch.flag");
            child.setAttribute("deadlatch.leg", "watch");
            child.setAttribute("deadlatch.package", "tripwire");
            if (scenario?.name != null) child.setAttribute("tripwire.scenario", String(scenario.name));
            child.setStatus({
              code: SpanStatusCode.ERROR,
              message: (sc.ranWithError as string) ?? "expectation violated",
            });
            child.end();
          }
        }

        if (s && s.violatedScenarios > 0) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `${s.violatedScenarios} scenario(s) violated`,
          });
        }

        span.end();
        return report;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.end();
        throw err;
      }
    });
}
