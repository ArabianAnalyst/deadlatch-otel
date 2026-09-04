import { test, before } from "node:test";
import assert from "node:assert/strict";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { instrumentPurse, instrumentRecorder, instrumentScan } from "../src/index.js";

const exporter = new InMemorySpanExporter();

before(() => {
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

test("purse: an allowed spend emits an ok enforce span", () => {
  exporter.reset();
  const purse = instrumentPurse({
    authorize: (r) => ({ status: (r as { payee: string }).payee === "bad" ? "denied" : "allowed" }),
  });
  const d = purse.authorize({ amount: "$1", payee: "good", intent: "x" });
  assert.equal(d.status, "allowed");
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.name, "deadlatch.enforce");
  assert.equal(span.attributes["deadlatch.leg"], "enforce");
  assert.equal(span.attributes["purse.decision"], "allowed");
  assert.equal(span.status.code, 0); // UNSET/OK
});

test("purse: a denied spend marks the span as error", () => {
  exporter.reset();
  const purse = instrumentPurse({
    authorize: () => ({ status: "denied", reason: "off allowlist" }),
  });
  purse.authorize({ amount: "$40", payee: "bad" });
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.attributes["purse.decision"], "denied");
  assert.equal(span.status.code, 2); // ERROR
});

test("blackbox: verify on a broken chain emits an error prove span", () => {
  exporter.reset();
  const recorder = instrumentRecorder({
    record: (e) => ({ ...(e as object), seq: 1, hash: "abc123" }),
    verify: () => ({ ok: false, brokenAt: 2 }),
  });
  recorder.record({ action: "pay", outcome: "ok" });
  const res = recorder.verify();
  assert.equal(res.ok, false);
  const spans = exporter.getFinishedSpans();
  const rec = spans.find((s) => s.name === "deadlatch.prove");
  const ver = spans.find((s) => s.name === "deadlatch.prove.verify");
  assert.ok(rec, "record span emitted");
  assert.equal(rec!.attributes["blackbox.action"], "pay");
  assert.ok(ver, "verify span emitted");
  assert.equal(ver!.attributes["blackbox.chain_ok"], false);
  assert.equal(ver!.attributes["blackbox.broken_at"], 2);
  assert.equal(ver!.status.code, 2); // ERROR
});

test("blackbox: a receipt envelope (blackbox >= 0.2) is read from payload", () => {
  exporter.reset();
  const recorder = instrumentRecorder({
    record: (e) => ({ id: "id-1", ts: "2026-09-04T00:00:00.000Z", kind: "action", payload: e as object, prevHash: "0".repeat(64), hash: "abc123" }),
    verify: () => ({ ok: true }),
  });
  recorder.record({ action: "pay", outcome: "error", error: "declined" });
  const rec = exporter.getFinishedSpans().find((s) => s.name === "deadlatch.prove");
  assert.ok(rec, "record span emitted");
  assert.equal(rec!.attributes["blackbox.action"], "pay");
  assert.equal(rec!.attributes["blackbox.outcome"], "error");
  assert.equal(rec!.attributes["blackbox.hash"], "abc123");
  assert.equal(rec!.status.code, 2); // ERROR, from payload.outcome
});

test("tripwire: a violated scan emits a watch span plus a flag child", async () => {
  exporter.reset();
  const scan = instrumentScan(async () => ({
    summary: { totalScenarios: 2, violatedScenarios: 1, suspicions: 0 },
    scenarios: [
      { scenario: { name: "in-policy" }, checks: [{ passed: true }], suspicions: [] },
      { scenario: { name: "overspend" }, checks: [{ passed: false }], suspicions: [] },
    ],
  }));
  const report = await scan({}, {});
  assert.equal(report.summary.violatedScenarios, 1);
  const spans = exporter.getFinishedSpans();
  const watch = spans.find((s) => s.name === "deadlatch.watch");
  const flag = spans.find((s) => s.name === "deadlatch.watch.flag");
  assert.ok(watch, "watch span emitted");
  assert.equal(watch!.attributes["tripwire.violations"], 1);
  assert.equal(watch!.status.code, 2); // ERROR
  assert.ok(flag, "flag child span emitted");
  assert.equal(flag!.attributes["tripwire.scenario"], "overspend");
});
