import { SpanStatusCode, metrics, type Attributes, type Span } from "@opentelemetry/api";
import { getTracer, DEADLATCH_TRACER } from "./otel.js";
import type { BrokerLike, BrokerRequestLike, BrokerExecuteLike, InstrumentBrokerOptions } from "./types.js";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function base(span: Span): void {
  span.setAttribute("deadlatch.leg", "enforce");
  span.setAttribute("deadlatch.package", "purse");
}

/**
 * Wrap a Purse Broker (enforcement mode) so request(), execute(), approve() and deny()
 * each emit one `deadlatch.enforce.*` span, and decisions, executions, pending approvals
 * and store health flow as metrics. Instrumented in place; the broker is returned.
 */
export function instrumentBroker<T extends BrokerLike>(broker: T, opts: InstrumentBrokerOptions = {}): T {
  const tracer = getTracer(opts.tracerName ?? DEADLATCH_TRACER);
  const meter = metrics.getMeter(opts.meterName ?? DEADLATCH_TRACER);
  const decisions = meter.createCounter("deadlatch.purse.decisions", { description: "Spend decisions by outcome" });
  const executions = meter.createCounter("deadlatch.purse.executions", { description: "Grant executions by status" });

  if (typeof broker.pending === "function") {
    meter.createObservableGauge("deadlatch.purse.approvals.pending", { description: "Spends waiting for a principal" })
      .addCallback((r) => { try { r.observe(broker.pending!().length); } catch { /* keep observing */ } });
  }
  if (opts.store?.pending) {
    const s = opts.store;
    meter.createObservableGauge("deadlatch.purse.store.pending", { description: "Receipts queued but not yet durable" })
      .addCallback((r) => { try { r.observe(s.pending!()); } catch { /* keep observing */ } });
  }
  if (opts.store?.degraded) {
    const s = opts.store;
    meter.createObservableGauge("deadlatch.purse.store.degraded", { description: "1 when the audit store has latched" })
      .addCallback((r) => { try { r.observe(s.degraded!() ? 1 : 0); } catch { /* keep observing */ } });
  }

  const origRequest = broker.request.bind(broker);
  broker.request = ((req: unknown): BrokerRequestLike =>
    tracer.startActiveSpan("deadlatch.enforce.request", (span) => {
      base(span);
      const r = req as { amount?: unknown; payee?: unknown } | null;
      if (r?.amount != null) span.setAttribute("purse.amount", String(r.amount));
      if (r?.payee != null) span.setAttribute("purse.payee", String(r.payee));
      let out: BrokerRequestLike;
      try {
        out = origRequest(req);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage(err) });
        span.end();
        throw err;
      }
      const attrs: Attributes = { "purse.decision": out.decision };
      if (out.reason) attrs["purse.reason"] = out.reason;
      if (out.grantId) attrs["purse.grant_id"] = out.grantId;
      if (out.pendingId) attrs["purse.pending_id"] = out.pendingId;
      span.setAttributes(attrs);
      if (out.decision === "denied") span.setStatus({ code: SpanStatusCode.ERROR, message: out.reason ?? "denied" });
      decisions.add(1, { decision: out.decision });
      span.end();
      return out;
    })) as T["request"];

  const origExecute = broker.execute.bind(broker);
  broker.execute = ((grantId: string): Promise<BrokerExecuteLike> =>
    tracer.startActiveSpan("deadlatch.enforce.execute", async (span) => {
      base(span);
      span.setAttribute("purse.grant_id", grantId);
      try {
        const out = await origExecute(grantId);
        span.setAttribute("purse.status", out.status);
        if (out.reason) span.setAttribute("purse.reason", out.reason);
        if (out.status !== "paid") span.setStatus({ code: SpanStatusCode.ERROR, message: out.reason ?? out.status });
        executions.add(1, { status: out.status });
        return out;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage(err) });
        executions.add(1, { status: "error" });
        throw err;
      } finally {
        span.end();
      }
    })) as T["execute"];

  for (const name of ["approve", "deny"] as const) {
    const orig = broker[name];
    if (typeof orig !== "function") continue;
    const bound = (orig as (pendingId: string) => unknown).bind(broker);
    (broker as Record<string, unknown>)[name] = (pendingId: string): unknown =>
      tracer.startActiveSpan(`deadlatch.enforce.${name}`, (span) => {
        base(span);
        span.setAttribute("purse.pending_id", pendingId);
        try {
          return bound(pendingId);
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage(err) });
          throw err;
        } finally {
          span.end();
        }
      });
  }

  return broker;
}
