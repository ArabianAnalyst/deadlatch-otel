// deadlatch-otel — bridge the Deadlatch control plane to OpenTelemetry.
//
// Observability tells you what an agent did. Deadlatch is the span that says
// what it was allowed to do, whether it was stopped, and whether the record
// still verifies. Instrument any of the three legs and the spans flow into
// Grafana, agento11y, or any OTel backend, unchanged.

export { instrumentPurse } from "./purse.js";
export { instrumentBroker } from "./broker.js";
export { instrumentRecorder } from "./blackbox.js";
export { instrumentScan } from "./tripwire.js";
export { getTracer, DEADLATCH_TRACER } from "./otel.js";

export type {
  PurseLike,
  PurseDecisionLike,
  RecorderLike,
  VerifyResultLike,
  ScanLike,
  ScanReportLike,
  ScanSummaryLike,
  BrokerLike,
  BrokerRequestLike,
  BrokerExecuteLike,
  StoreHealthLike,
  InstrumentBrokerOptions,
} from "./types.js";
