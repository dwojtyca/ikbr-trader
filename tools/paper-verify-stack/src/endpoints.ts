/**
 * PR15.1 — closed allowlist of endpoints the tool is allowed
 * to GET. Any request outside this table MUST be rejected by
 * the transport before any network call.
 */

export type EndpointService = "ingestion" | "signal" | "execution";

export interface EndpointDescriptor {
  readonly service: EndpointService;
  readonly path: string;
  readonly bearer: boolean;
}

export const ENDPOINTS = {
  INGESTION_HEALTH: {
    service: "ingestion",
    path: "/health",
    bearer: false,
  },
  INGESTION_WATCHLIST: {
    service: "ingestion",
    path: "/watchlist",
    bearer: false,
  },
  SIGNAL_HEALTH: {
    service: "signal",
    path: "/health",
    bearer: false,
  },
  SIGNAL_RUNTIME_HEALTH: {
    service: "signal",
    path: "/runtime/health",
    bearer: false,
  },
  SIGNAL_RUNTIME_READY: {
    service: "signal",
    path: "/runtime/ready",
    bearer: false,
  },
  SIGNAL_EXECUTE_READY: {
    service: "signal",
    path: "/runtime/execute/ready",
    bearer: false,
  },
  SIGNAL_LOOP_STATUS: {
    service: "signal",
    path: "/runtime/trading-loop/status",
    bearer: false,
  },
  SIGNAL_LOOP_READY: {
    service: "signal",
    path: "/runtime/trading-loop/ready",
    bearer: false,
  },
  EXECUTION_HEALTH: {
    service: "execution",
    path: "/health",
    bearer: false,
  },
  EXECUTION_READY: {
    service: "execution",
    path: "/ready",
    bearer: true,
  },
  EXECUTION_KILL_SWITCH: {
    service: "execution",
    path: "/execution/kill-switch",
    bearer: true,
  },
  RECON_LATEST: {
    service: "execution",
    path: "/execution/reconciliation/latest",
    bearer: true,
  },
  RECON_HOLDS_ACTIVE: {
    service: "execution",
    path: "/execution/reconciliation/holds?active=true",
    bearer: true,
  },
  EXECUTION_ACCOUNT_SUMMARY: {
    service: "execution",
    path: "/execution/account/summary",
    bearer: true,
  },
} as const satisfies Record<string, EndpointDescriptor>;

export type EndpointKey = keyof typeof ENDPOINTS;

export function isEndpointKey(key: string): key is EndpointKey {
  return Object.prototype.hasOwnProperty.call(ENDPOINTS, key);
}
