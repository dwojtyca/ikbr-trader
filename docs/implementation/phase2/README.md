# Phase 2 runtime documentation

Updated 2026-09-26. This directory contains delivered reliability/entry work and
historical ES research. The current queue is [ROADMAP](../ROADMAP.md), with
[actual capabilities](../CURRENT_STATE.md) and the
[production-style Paper plan](../phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md).

## Current references

- [Runtime flow](RUNTIME_FLOW.md): bound strategy proposal, mandatory persisted AI,
  fresh execution risk, broker dispatch and lifecycle.
- [Configuration](CONFIGURATION.md): settings implemented today, distinct from the
  proposed strategy-instance/instrument format.
- [State and reconciliation](STATE_AND_RECONCILIATION.md): durable identity,
  coverage, ownership and uncertainty.
- [Failure and recovery](FAILURE_AND_RECOVERY.md): no blind retries and current
  close limitations.
- [Testing and rollout](TESTING_AND_ROLLOUT.md): checks and operational proof.

## Historical scope

[Phase2 roadmap](PHASE_2_ROADMAP.md) preserves PR11–PR18 planning history;
[Paper mechanics direction](PAPER_MECHANICS_DELIVERY.md) records the earlier
single-instrument milestone. Their historical next-step statements do not override
the owner's current production-Paper objective. AI integration and one-share full
close have shipped since the early entry-only plans.

The ES D.3 verdict stays REJECTED_FOR_ES and PR15.5F local diagnostics remain
unfinished/deferred. See the [complete docs inventory](../../README.md) for status.
No document in this directory activates an instrument or grants broker permission.
