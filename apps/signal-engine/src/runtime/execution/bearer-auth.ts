/**
 * Execution Runtime — minimal Bearer auth preHandler.
 *
 * PR13 protects the write endpoint `POST /runtime/execute` with the
 * SAME `EXECUTION_API_TOKEN` used by every other internal client
 * (per AGENTS.md "Phase 1 token model — jeden `EXECUTION_API_TOKEN`
 * czytany przez wszystkie serwisy"). Callers that already have this
 * token to reach execution-engine can reach the runtime with the
 * same secret; no new secret is introduced.
 *
 * This module intentionally does NOT reproduce execution-engine's
 * full audit surface (correlation IDs, request-hash fingerprints,
 * failure-burst detector). Those live in
 * `apps/execution-engine/src/auth.ts` and belong to execution-engine's
 * write edge — the runtime is a client of that edge, not a
 * replacement for it.
 */

import { bearerAuthorized } from "@ikbr/shared/http-auth";
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

export interface RuntimeBearerAuthOptions {
  /**
   * The token clients must present. An empty string denies ALL
   * requests (fail-closed) — same behaviour as execution-engine's
   * auth middleware.
   */
  readonly token: string;
}

export function createRuntimeBearerAuth(
  options: RuntimeBearerAuthOptions,
): preHandlerAsyncHookHandler {
  const expected = options.token;
  return async function bearerAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!bearerAuthorized(request.headers.authorization, expected)) {
      reply.code(401).send({ error: "unauthorized" });
    }
  };
}
