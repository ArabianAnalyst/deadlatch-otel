// Structural shapes only. This package depends on nothing but @opentelemetry/api,
// so it never imports purse, blackbox, or tripwire. Any object matching the shape
// below can be instrumented, and the three core packages stay zero-dependency.

export interface PurseDecisionLike {
  status: string; // "allowed" | "needs_approval" | "denied" | ...
  reason?: string;
}

export interface PurseLike {
  authorize(req: unknown): PurseDecisionLike;
}

export interface VerifyResultLike {
  ok: boolean;
  brokenAt?: number;
  reason?: string;
}

export interface RecorderLike {
  record(entry: unknown): unknown;
  verify(): VerifyResultLike;
}

export interface ScanSummaryLike {
  totalScenarios: number;
  violatedScenarios: number;
  suspicions: number;
}

export interface ScanReportLike {
  summary: ScanSummaryLike;
  scenarios: unknown[];
}

export type ScanLike = (
  entrypoint: unknown,
  options?: unknown
) => Promise<ScanReportLike> | ScanReportLike;
