# Changelog

## 0.2.0 (2026-09-04)

Adds `instrumentBroker` for Purse enforcement mode, with spans for request, execute, approve and deny, and metrics for decisions, executions, pending approvals, and audit store health. `@opentelemetry/api` remains the only runtime dependency. Instruments are created lazily so SDK registration order does not matter. The request span carries `purse.intent` and `deadlatch.held`.

## 0.1.1 (2026-09-04)

Reads blackbox 0.2 receipt envelopes as well as the flat 0.1 shape. Never emits NaN for `blackbox.broken_at`; adds `blackbox.broken_id`.
