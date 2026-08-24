import { SpanStatusCode } from "@opentelemetry/api";
import { getTracer, DEADLATCH_TRACER } from "./otel.js";
import type { PurseLike, PurseDecisionLike } from "./types.js";

/**
 * Wrap a Purse (advisory) so every authorize() emits one `deadlatch.enforce`
 * span. Denied spends are marked ERROR so they surface on a dashboard, held
 * spends carry `deadlatch.held`. Returns the same instance, instrumented in place.
 */
export function instrumentPurse<T extends PurseLike>(
  purse: T,
  tracerName: string = DEADLATCH_TRACER
): T {
  const tracer = getTracer(tracerName);
  const original = purse.authorize.bind(purse);

  purse.authorize = ((req: unknown): PurseDecisionLike =>
    tracer.startActiveSpan("deadlatch.enforce", (span) => {
      let decision: PurseDecisionLike;
      try {
        decision = original(req);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage(err) });
        span.end();
        throw err;
      }

      const r = req as Record<string, unknown>;
      span.setAttribute("deadlatch.leg", "enforce");
      span.setAttribute("deadlatch.package", "purse");
      if (r?.amount != null) span.setAttribute("purse.amount", String(r.amount));
      if (r?.payee != null) span.setAttribute("purse.payee", String(r.payee));
      if (r?.intent != null) span.setAttribute("purse.intent", String(r.intent));
      span.setAttribute("purse.decision", decision.status);
      if (decision.reason) span.setAttribute("purse.reason", decision.reason);

      if (decision.status === "denied") {
        span.setStatus({ code: SpanStatusCode.ERROR, message: decision.reason ?? "denied" });
      } else if (decision.status === "needs_approval") {
        span.setAttribute("deadlatch.held", true);
      }

      span.end();
      return decision;
    })) as T["authorize"];

  return purse;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
