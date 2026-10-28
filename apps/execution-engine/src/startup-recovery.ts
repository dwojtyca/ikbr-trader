import { setTimeout as delay } from "node:timers/promises";

export function isDatabaseUnavailable(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current);
    const code = (current as Error & { code?: string }).code;
    if (typeof code === "string" && (/^08[0-9A-Z]{3}$/.test(code) || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "57P01", "57P02", "57P03", "53300"].includes(code))) return true;
    if (/^(Connection terminated unexpectedly|Connection terminated|timeout exceeded when trying to connect|Connection terminated due to connection timeout)$/.test(current.message)) return true;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return false;
    current = current.cause;
  }
  return false;
}

export async function initializeWithDatabaseRetry(initialize: () => Promise<void>, options: {
  signal: AbortSignal;
  onRetry(error: unknown, retryMs: number): void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  let attempt = 0;
  while (!options.signal.aborted) {
    try { await initialize(); options.signal.throwIfAborted(); return; }
    catch (error) {
      options.signal.throwIfAborted();
      if (!isDatabaseUnavailable(error)) throw error;
      const retryMs = [1000, 2000, 5000, 10000, 30000][Math.min(attempt++, 4)];
      options.onRetry(error, retryMs);
      await (options.wait ?? ((ms, signal) => delay(ms, undefined, { signal })))(retryMs, options.signal);
    }
  }
  options.signal.throwIfAborted();
}

export async function drainShutdown(steps: readonly { name: string; close(): void | Promise<void> }[],
  report: (name: string, error: unknown) => void, timeoutMs = 3000): Promise<boolean> {
  let healthy = true;
  for (const step of steps) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => step.close()), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("SHUTDOWN_STEP_TIMEOUT")), timeoutMs);
      })]);
    } catch (error) { healthy = false; report(step.name, error); }
    finally { clearTimeout(timer); }
  }
  return healthy;
}
