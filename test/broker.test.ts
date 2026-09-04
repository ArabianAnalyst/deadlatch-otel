import { test } from "node:test";
import assert from "node:assert/strict";
import { trace, metrics } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { Broker, MockExecutor } from "@olurabian/purse";
import { instrumentBroker } from "../src/index.js";

const spans = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
trace.setGlobalTracerProvider(tracerProvider);
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 });
const meterProvider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(meterProvider);

function metricPoints(name: string, exporter: InMemoryMetricExporter = metricExporter) {
  const out: { value: number; attrs: Record<string, unknown> }[] = [];
  for (const rm of exporter.getMetrics()) for (const sm of rm.scopeMetrics) for (const m of sm.metrics) {
    if (m.descriptor.name !== name) continue;
    for (const dp of m.dataPoints) out.push({ value: Number(dp.value), attrs: dp.attributes as Record<string, unknown> });
  }
  return out;
}

test("request, execute, approve and deny emit enforce spans with attributes", async () => {
  spans.reset();
  const b = instrumentBroker(new Broker({ maxPerAction: "$5", requireApprovalOver: "$3", allow: ["api.stripe.com"], executor: new MockExecutor() }));
  const r = b.request({ amount: "$1", payee: "api.stripe.com", intent: "credits" });
  const x = await b.execute(r.grantId!);
  const p = b.request({ amount: "$4", payee: "api.stripe.com", intent: "big" });
  b.approve(p.pendingId!);
  const d = b.request({ amount: "$4", payee: "api.stripe.com", intent: "big2" });
  b.deny(d.pendingId!);
  const denied = b.request({ amount: "$9", payee: "api.stripe.com", intent: "too big" });
  assert.equal(x.status, "paid");
  assert.equal(denied.decision, "denied");
  const names = spans.getFinishedSpans().map((s) => s.name);
  assert.deepEqual(names, [
    "deadlatch.enforce.request", "deadlatch.enforce.execute",
    "deadlatch.enforce.request", "deadlatch.enforce.approve",
    "deadlatch.enforce.request", "deadlatch.enforce.deny",
    "deadlatch.enforce.request",
  ]);
  const first = spans.getFinishedSpans()[0]!;
  assert.equal(first.attributes["purse.decision"], "allowed");
  assert.equal(first.attributes["purse.payee"], "api.stripe.com");
  assert.equal(first.attributes["purse.intent"], "credits");
  assert.equal(first.attributes["deadlatch.leg"], "enforce");
  assert.equal(typeof first.attributes["purse.grant_id"], "string");
  const last = spans.getFinishedSpans().at(-1)!;
  assert.equal(last.attributes["purse.decision"], "denied");
  assert.equal(last.status.code, 2); // SpanStatusCode.ERROR
  const exec = spans.getFinishedSpans()[1]!;
  assert.equal(exec.attributes["purse.status"], "paid");
  const held = spans.getFinishedSpans()[2]!;
  assert.equal(held.attributes["purse.decision"], "needs_approval");
  assert.equal(held.attributes["deadlatch.held"], true);
});

test("a rejected execute and a thrown execute mark the span as error", async () => {
  spans.reset();
  const b = instrumentBroker(new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], executor: new MockExecutor() }));
  const x = await b.execute("no-such-grant");
  assert.equal(x.status, "rejected");
  assert.equal(spans.getFinishedSpans()[0]!.status.code, 2);
  const boom = { ...b, execute: async () => { throw new Error("db down"); } } as unknown as Broker;
  const wrapped = instrumentBroker(boom);
  await assert.rejects(wrapped.execute("x"), /db down/);
  assert.equal(spans.getFinishedSpans()[1]!.status.code, 2);
});

test("counters and gauges are recorded", async () => {
  let pending = 3; let degraded: Error | null = null;
  const b = instrumentBroker(new Broker({ maxPerAction: "$5", requireApprovalOver: "$3", allow: ["api.stripe.com"], executor: new MockExecutor() }), {
    store: { pending: () => pending, degraded: () => degraded },
  });
  const r = b.request({ amount: "$1", payee: "api.stripe.com", intent: "c" });
  await b.execute(r.grantId!);
  b.request({ amount: "$4", payee: "api.stripe.com", intent: "needs approval" });
  b.request({ amount: "$9", payee: "api.stripe.com", intent: "denied" });
  degraded = new Error("latched");
  await reader.forceFlush();
  const decisions = metricPoints("deadlatch.purse.decisions");
  const byDecision = Object.fromEntries(decisions.map((p) => [p.attrs.decision, p.value]));
  assert.ok(byDecision.allowed >= 1 && byDecision.needs_approval >= 1 && byDecision.denied >= 1, JSON.stringify(byDecision));
  const executions = metricPoints("deadlatch.purse.executions");
  assert.ok(executions.some((p) => p.attrs.status === "paid" && p.value >= 1));
  assert.equal(metricPoints("deadlatch.purse.store.pending").at(-1)?.value, 3);
  assert.equal(metricPoints("deadlatch.purse.store.degraded").at(-1)?.value, 1);
  assert.equal(metricPoints("deadlatch.purse.approvals.pending").at(-1)?.value, 1);
});

// Ordered last: it calls metrics.disable() to simulate a host that registers its
// MeterProvider after instrumentBroker() has already run. That call tears down the
// global no-op meter the tests above share, so it must not run before them.
test("metrics work when the SDK is registered after instrumentation", async () => {
  metrics.disable();
  const b = instrumentBroker(new Broker({ maxPerAction: "$5", allow: ["api.stripe.com"], executor: new MockExecutor() }));

  const lateExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const lateReader = new PeriodicExportingMetricReader({ exporter: lateExporter, exportIntervalMillis: 3_600_000 });
  const lateProvider = new MeterProvider({ readers: [lateReader] });
  metrics.setGlobalMeterProvider(lateProvider);

  const r = b.request({ amount: "$1", payee: "api.stripe.com", intent: "late-bind" });
  await b.execute(r.grantId!);
  await lateReader.forceFlush();

  const decisions = metricPoints("deadlatch.purse.decisions", lateExporter);
  assert.ok(decisions.some((p) => p.attrs.decision === "allowed" && p.value >= 1), JSON.stringify(decisions));
  const executions = metricPoints("deadlatch.purse.executions", lateExporter);
  assert.ok(executions.some((p) => p.attrs.status === "paid" && p.value >= 1), JSON.stringify(executions));
});
