import { trace, type Tracer } from "@opentelemetry/api";

export const DEADLATCH_TRACER = "deadlatch";

export function getTracer(name: string = DEADLATCH_TRACER): Tracer {
  return trace.getTracer(name);
}
