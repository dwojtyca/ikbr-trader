# Zero-total completed Filled compatibility

The [accepted plan](COMPLETED_ZERO_TOTAL_PLAN.md) adds one observed IBKR completed
record representation: exact terminal Filled, totalQuantity zero, valid positive
filledQuantity. It preserves broker filled quantity and asserts remaining zero
from the terminal status, without reconstructing an original total or parsing a
human-readable status. All other quantity, identity, end-marker, account/session
and recovery-coverage guards remain unchanged. No ownership or fill is fabricated.

Independent plan and implementation reviews accepted the change. Targeted checks:
47 unit and 7 isolated PostgreSQL tests passed, also independently repeated. The
production client/adapter/runner regression preserves external completed evidence
without linking it or changing an unrelated proposal.

Clean-copy lint, typecheck, unit tests, integration tests and build passed. The
first integration run had lifecycle snapshot-time assertion failures while Docker
build and other checks were running; an unchanged-code rerun passed. The cause of
that transient failure is not proven. No production time guard was relaxed.
Docker build passed with digest
`sha256:21e1bbf7f6934ad1e03f20cee69ee004d1861d762faae37f60f9013f721cdc5e`.
Code commit `14544cc` passed [GitHub CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/36017265927).
The reviewed execution image was deployed with writes/loop disabled and explicit
Warsaw Gateway timezone unchanged. The subsequent actual broker capture finished
CLEAN with available completed-order coverage and complete exposure/recovery.
No database status was manually repaired and no new order was submitted.

The separate AAPL profile work is not included in this fix. Trading remains off.
Private broker/account/quantity evidence is excluded from this report.
