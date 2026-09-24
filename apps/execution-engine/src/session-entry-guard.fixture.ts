import type { SessionEntryGuard } from './session-entry-guard.js';

// Explicit test double for pre-existing focused submission/reconciliation tests.
// Production never imports this file. Real calendar acceptance is exercised by
// session-entry and AAPL window PostgreSQL tests with the production SQL guard.
export const focusedSubmissionTestSessionGuard: SessionEntryGuard = async () => ({
  ok: true, generation: 1, endsAtMs: Date.now() + 60000,
});
