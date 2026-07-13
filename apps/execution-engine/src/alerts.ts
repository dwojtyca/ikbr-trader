import { config } from "./config.js";
import type { ExecutionRepository } from "./repository.js";

// Phase 1 / PR2: `CRITICAL` extends the severity ladder above `error` so
// that specific safety events (e.g. DIRECT_TICKET_USED in PR4) can always
// be delivered to Telegram regardless of the operator's `ALERT_MIN_SEVERITY`
// filter. `AUTH_FAILURE_BURST` uses `warn` — it is expected periodic noise
// in production and should not page the operator every time.
export type AlertSeverity = "info" | "warn" | "error" | "CRITICAL";

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
  CRITICAL: 3,
};

export type AlertKind =
  | "tws_connection"
  | "order_rejected"
  | "order_broker_error"
  | "order_filled"
  | "kill_switch_triggered"
  | "reconciliation_mismatch"
  | "reconciliation_run"
  | "startup"
  | "system"
  | "auth_failure_burst"
  | "direct_ticket_used";

export interface AlertInput {
  severity: AlertSeverity;
  kind: AlertKind;
  message: string;
  payload?: Record<string, unknown>;
}

export interface AlertNotifier {
  record(alert: AlertInput): Promise<void>;
}

interface AlertLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * Persists alerts into the system_alerts table and, when configured,
 * forwards them to a Telegram chat. Designed to be fire-and-forget from
 * the caller's perspective: failures are logged but never thrown so the
 * trading path is never blocked by a flaky notification channel.
 */
export class AlertService implements AlertNotifier {
  private readonly minRank: number;
  private readonly telegramEnabled: boolean;

  constructor(
    private readonly repo: ExecutionRepository,
    private readonly logger: AlertLogger,
  ) {
    const min = (config.ALERT_MIN_SEVERITY as AlertSeverity) ?? "warn";
    this.minRank = SEVERITY_RANK[min] ?? SEVERITY_RANK.warn;
    this.telegramEnabled = Boolean(
      config.ALERT_TELEGRAM_BOT_TOKEN && config.ALERT_TELEGRAM_CHAT_ID,
    );
  }

  async record(alert: AlertInput): Promise<void> {
    let alertId: number | undefined;
    try {
      alertId = await this.repo.insertSystemAlert(alert);
    } catch (error) {
      this.logger.error(
        { err: error, alert },
        "failed to persist system alert",
      );
    }

    if (!this.telegramEnabled) return;
    // CRITICAL always ships to Telegram, ignoring ALERT_MIN_SEVERITY.
    if (
      alert.severity !== "CRITICAL" &&
      SEVERITY_RANK[alert.severity] < this.minRank
    ) {
      return;
    }

    void this.sendTelegram(alert)
      .then(async () => {
        if (alertId !== undefined) {
          try {
            await this.repo.markSystemAlertDelivered(alertId);
          } catch (error) {
            this.logger.warn(
              { err: error, alertId },
              "failed to mark alert delivered",
            );
          }
        }
      })
      .catch((error) => {
        this.logger.warn(
          { err: error, alert },
          "failed to deliver telegram alert",
        );
      });
  }

  private async sendTelegram(alert: AlertInput): Promise<void> {
    const token = config.ALERT_TELEGRAM_BOT_TOKEN;
    const chatId = config.ALERT_TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const icon =
      alert.severity === "CRITICAL"
        ? "🚨"
        : alert.severity === "error"
          ? "🔴"
          : alert.severity === "warn"
            ? "🟡"
            : "🔵";
    const lines = [
      `${icon} <b>${escapeHtml(alert.kind)}</b>`,
      escapeHtml(alert.message),
    ];

    if (alert.payload && Object.keys(alert.payload).length > 0) {
      const json = JSON.stringify(alert.payload, null, 2);
      const truncated = json.length > 1500 ? `${json.slice(0, 1500)}…` : json;
      lines.push(`<pre>${escapeHtml(truncated)}</pre>`);
    }

    const body = JSON.stringify({
      chat_id: chatId,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text: lines.join("\n"),
    });

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        throw new Error(
          `telegram api status=${response.status} body=${text.slice(0, 300)}`,
        );
      }
      // Telegram returns HTTP 200 even for some logical errors; surface
      // ok:false from the API payload so misconfigured chats are visible
      // in logs (e.g. "chat not found" if the user never started the bot).
      try {
        const parsed = JSON.parse(text) as {
          ok?: boolean;
          description?: string;
        };
        if (parsed.ok === false) {
          throw new Error(
            `telegram api ok=false description=${parsed.description ?? "unknown"}`,
          );
        }
      } catch (parseError) {
        if (
          parseError instanceof Error &&
          parseError.message.startsWith("telegram api ok=false")
        ) {
          throw parseError;
        }
        // non-JSON body on 200 is unexpected but not necessarily fatal
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
