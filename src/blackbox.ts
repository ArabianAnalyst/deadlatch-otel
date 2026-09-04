import { SpanStatusCode } from "@opentelemetry/api";
import { getTracer, DEADLATCH_TRACER } from "./otel.js";
import type { RecorderLike, VerifyResultLike } from "./types.js";

/**
 * Wrap a blackbox recorder so record() emits a `deadlatch.prove` span per action
 * and verify() emits a `deadlatch.prove.verify` span. A broken chain marks the
 * span ERROR and carries the record it broke at. Instrumented in place.
 */
export function instrumentRecorder<T extends RecorderLike>(
  recorder: T,
  tracerName: string = DEADLATCH_TRACER
): T {
  const tracer = getTracer(tracerName);
  const origRecord = recorder.record.bind(recorder);
  const origVerify = recorder.verify.bind(recorder);

  recorder.record = ((entry: unknown): unknown =>
    tracer.startActiveSpan("deadlatch.prove", (span) => {
      const rec = origRecord(entry) as Record<string, unknown>;
      // blackbox >= 0.2 returns a receipt envelope with the action fields under
      // payload; older versions return them flat. Read whichever is present.
      const p = (rec?.payload ?? rec) as Record<string, unknown>;
      span.setAttribute("deadlatch.leg", "prove");
      span.setAttribute("deadlatch.package", "blackbox");
      if (p?.action != null) span.setAttribute("blackbox.action", String(p.action));
      if (p?.outcome != null) span.setAttribute("blackbox.outcome", String(p.outcome));
      if (rec?.seq != null) span.setAttribute("blackbox.seq", Number(rec.seq));
      if (rec?.hash != null) span.setAttribute("blackbox.hash", String(rec.hash));
      if (p?.outcome === "error") {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(p.error ?? "error") });
      }
      span.end();
      return rec;
    })) as T["record"];

  recorder.verify = ((): VerifyResultLike =>
    tracer.startActiveSpan("deadlatch.prove.verify", (span) => {
      const res = origVerify();
      span.setAttribute("deadlatch.leg", "prove");
      span.setAttribute("deadlatch.package", "blackbox");
      span.setAttribute("blackbox.chain_ok", !!res.ok);
      if (!res.ok) {
        // blackbox >= 0.2 reports brokenAt as a numeric array index plus a
        // separate id field. blackbox 0.1 reported brokenAt as the broken
        // record's id, a string, with no id field. Read whichever is present
        // and never coerce a non-numeric brokenAt into NaN.
        const raw = res as unknown as { brokenAt?: unknown; id?: unknown };
        if (typeof raw.brokenAt === "number") {
          span.setAttribute("blackbox.broken_at", raw.brokenAt);
        } else if (typeof raw.brokenAt === "string") {
          span.setAttribute("blackbox.broken_id", raw.brokenAt);
        }
        if (typeof raw.id === "string") {
          span.setAttribute("blackbox.broken_id", raw.id);
        }
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: res.reason ?? `chain broken at ${res.brokenAt}`,
        });
      }
      span.end();
      return res;
    })) as T["verify"];

  return recorder;
}
