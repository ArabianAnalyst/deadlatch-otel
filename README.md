<div align="center">
  <img src="assets/logo.png" width="118" alt="deadlatch-otel" />
  <h1>deadlatch-otel</h1>
  <p><b>Emit your agent's control events as OpenTelemetry spans.</b></p>
  <p>
    <a href="https://www.npmjs.com/package/@olurabian/deadlatch-otel"><img src="https://img.shields.io/npm/v/@olurabian/deadlatch-otel?style=for-the-badge&label=npm&color=37D07E" alt="npm version" /></a>
    <img src="https://img.shields.io/badge/OpenTelemetry-native-425CC7?style=for-the-badge" alt="OpenTelemetry native" />
    <img src="https://img.shields.io/npm/l/@olurabian/deadlatch-otel?style=for-the-badge&label=license&color=2E3742" alt="MIT license" />
    <a href="https://github.com/ArabianAnalyst/deadlatch-otel/actions"><img src="https://img.shields.io/github/actions/workflow/status/ArabianAnalyst/deadlatch-otel/ci.yml?style=for-the-badge&label=build&branch=main" alt="build status" /></a>
  </p>
  <p><sub>The bridge from <a href="https://deadlatch.dev"><b>Deadlatch</b></a> to Grafana, agento11y, and any OTel backend</sub></p>
</div>

**Observability tells you what an agent did. It does not tell you what it was allowed to do, or whether it was stopped.** This package makes that a first-class span. Wrap Purse, blackbox, or Tripwire, and every enforce, prove, and watch event flows into the same OpenTelemetry backend as your traces, so the control plane shows up next to the observability plane in one Grafana view.

```bash
npm i @olurabian/deadlatch-otel
```

It wraps the three packages **from the outside**, so `@olurabian/purse`, `@olurabian/blackbox`, and `@olurabian/tripwire` stay zero-dependency. This adapter carries the one dependency they don't, `@opentelemetry/api`, by design.

## Instrument each leg

```ts
import { instrumentPurse, instrumentRecorder, instrumentScan } from "@olurabian/deadlatch-otel";

// enforce — every authorize() becomes a deadlatch.enforce span
const purse = instrumentPurse(new Purse({ maxPerAction: "$100", allow: ["api.stripe.com"] }));

// prove — record() and verify() become deadlatch.prove spans
const box = instrumentRecorder(createRecorder({ store: new MemoryStore() }));

// watch — scan() becomes a deadlatch.watch span, one child per violation
const watchedScan = instrumentScan(scan);
```

That is the whole integration. Use the objects exactly as before. The spans emit as a side effect.

## Enforcement mode

`instrumentBroker(broker, { store })` wraps a Purse `Broker`. Every `request()`, `execute()`, `approve()` and `deny()` becomes a `deadlatch.enforce.*` span, denied decisions and rejected executions are marked as errors, and five metrics flow through the OpenTelemetry API so whatever SDK you run collects them. `deadlatch.purse.decisions` and `deadlatch.purse.executions` are counters. `deadlatch.purse.approvals.pending`, `deadlatch.purse.store.pending` and `deadlatch.purse.store.degraded` are gauges, the last two read from the store you pass in, which is how a latched Postgres store becomes a page instead of a silence. Instruments are created on first use, so it does not matter whether you register your metrics SDK before or after wrapping the broker. Wrap one broker per process, or give each its own `meterName`, because gauges registered under one meter name replace each other silently.

## What lands in your backend

| Span | Leg | Key attributes | Marked ERROR when |
| --- | --- | --- | --- |
| `deadlatch.enforce` | Purse | `purse.amount`, `purse.payee`, `purse.decision` | the spend is **denied** (held spends carry `deadlatch.held`) |
| `deadlatch.prove` | blackbox | `blackbox.action`, `blackbox.outcome`, `blackbox.seq` | the recorded action outcome is `error` |
| `deadlatch.prove.verify` | blackbox | `blackbox.chain_ok`, `blackbox.broken_at` | the hash chain fails to verify |
| `deadlatch.watch` | Tripwire | `tripwire.scenarios`, `tripwire.violations`, `tripwire.suspicions` | any scenario is violated |
| `deadlatch.watch.flag` | Tripwire | `tripwire.scenario` | one child per violated scenario |

A denied spend or a broken chain arrives as an ERROR span, so it stands out on a dashboard instead of looking like any other call.

## Ship it to Grafana

The demo prints spans to the console. To send them to Grafana Agent Observability (agento11y) or any OTLP endpoint, swap the exporter.

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,       // your Grafana Cloud OTLP endpoint
    headers: { Authorization: process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "" },
  }))],
});
trace.setGlobalTracerProvider(provider);
```

Nothing else changes. The same spans that printed to your terminal now populate your dashboard.

```bash
npm run demo   # all three legs, to the console
```

## Why this exists

Watching an agent is not the same as being able to stop it. You can see every token an agent spends and still not have stopped the wrong payment. agento11y and Grafana are the observability plane. Deadlatch is the control plane. This package is the wire between them, so the record of what an agent *did* sits beside the record of what it was *allowed* to do.

## The Deadlatch stack

Part of [Deadlatch](https://deadlatch.dev), the open runtime governance stack for AI agents.

- **[Purse](https://github.com/ArabianAnalyst/purse)**, enforce. Stop the action off-policy, at the moment it happens.
- **[blackbox](https://github.com/ArabianAnalyst/blackbox)**, prove. A tamper-evident record, verifiable outside the tool.
- **[Tripwire](https://github.com/ArabianAnalyst/tripwire)**, watch. Catch the silent wrong action before a customer does.
- **deadlatch-otel**, this package. Bridge all three to OpenTelemetry.

## License

MIT. Built by [Oluwasegun Araba](https://olurabian.com).
