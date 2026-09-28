import { createElement } from "react";
import type { TradingLoopResult } from "./trading-loop";

export function TradingLoopResultView({
  result,
}: {
  result: TradingLoopResult;
}) {
  return createElement(
    "section",
    { "aria-label": "Trading loop result" },
    createElement(
      "p",
      null,
      `Cycle ${result.cycleId} · started ${result.startedAt} · finished ${result.finishedAt} · ${result.durationMs} ms`,
    ),
    result.reports.length === 0
      ? createElement("p", null, "No configured instruments were evaluated.")
      : createElement(
          "ul",
          null,
          ...result.reports.map((report, index) =>
            createElement(
              "li",
              { key: `${report.instrumentId}-${index}` },
              createElement(
                "strong",
                null,
                `${report.instrumentId}: ${report.outcome.kind}`,
              ),
              report.outcome.reason
                ? createElement("div", null, `Reason: ${report.outcome.reason}`)
                : null,
              report.outcome.message
                ? createElement("div", null, `Message: ${report.outcome.message}`)
                : null,
              report.outcome.idempotencyKey
                ? createElement(
                    "div",
                    null,
                    `Idempotency key: ${report.outcome.idempotencyKey}`,
                  )
                : null,
            ),
          ),
        ),
  );
}
