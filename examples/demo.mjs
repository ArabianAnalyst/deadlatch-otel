// The whole Deadlatch control plane, emitting OpenTelemetry spans.
//
// enforce (Purse) and prove (blackbox) run against the real published packages.
// watch wraps a scan the same way tripwire's scan() is wrapped, with an inline
// report so the demo needs no agent to drive. Spans print to the console here.
// Swap ConsoleSpanExporter for an OTLP exporter and they land in Grafana.

import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { Purse } from "@olurabian/purse";
import { createRecorder, MemoryStore } from "@olurabian/blackbox";
import { instrumentPurse, instrumentRecorder, instrumentScan } from "../dist/index.js";

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});
trace.setGlobalTracerProvider(provider);

// --- enforce ---------------------------------------------------------------
const purse = instrumentPurse(
  new Purse({
    maxPerAction: "$100.00",
    maxPerDay: "$200.00",
    allow: ["api.stripe.com"],
    requireApprovalOver: "$50.00",
  })
);
console.log("\n[enforce] three spends through Purse");
console.log("  $3  stripe        ->", purse.authorize({ amount: "$3.00", payee: "api.stripe.com", intent: "credits" }).status);
console.log("  $40 unknown       ->", purse.authorize({ amount: "$40.00", payee: "unknown-vendor.io", intent: "?" }).status);
console.log("  $80 stripe        ->", purse.authorize({ amount: "$80.00", payee: "api.stripe.com", intent: "annual" }).status);

// --- prove -----------------------------------------------------------------
const box = instrumentRecorder(createRecorder({ store: new MemoryStore() }));
console.log("\n[prove] record three actions, then verify the chain");
box.record({ action: "charge", input: { amount: 300 }, outcome: "ok", latencyMs: 12 });
box.record({ action: "email", input: { to: "client" }, outcome: "ok", latencyMs: 8 });
box.record({ action: "reconcile", input: { paid: true }, outcome: "ok", latencyMs: 5 });
console.log("  verify() ->", box.verify());

// --- watch -----------------------------------------------------------------
const scan = instrumentScan(async () => ({
  summary: { totalScenarios: 3, violatedScenarios: 1, suspicions: 0 },
  scenarios: [
    { scenario: { name: "in-policy refund" }, checks: [{ passed: true }] },
    { scenario: { name: "refund over cap" }, checks: [{ passed: false }] },
    { scenario: { name: "allowlisted payee" }, checks: [{ passed: true }] },
  ],
}));
console.log("\n[watch] scan an agent run for silent violations");
const report = await scan({}, {});
console.log("  violations ->", report.summary.violatedScenarios);

console.log("\n=== spans emitted (enforce, prove, watch) ===\n");
await provider.forceFlush();
await provider.shutdown();
