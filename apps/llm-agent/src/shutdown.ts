export function assertProcessActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("LLM_AGENT_SHUTTING_DOWN");
}

export async function whileProcessActive(signal: AbortSignal, work: () => Promise<void>): Promise<void> {
  assertProcessActive(signal);
  await work();
  assertProcessActive(signal);
}

export function installShutdown(options: {
  controller: AbortController;
  stop: () => void;
  drain: () => Promise<void>;
  close: () => Promise<void>;
  report: (fatal: boolean) => void;
  deadlineMs?: number;
}): (fatal?: boolean) => Promise<void> {
  let shutdown: Promise<void> | undefined;
  let exitCode = 0;
  const terminate = (fatal = false): Promise<void> => {
    if (fatal) exitCode = 1;
    if (shutdown) return shutdown;
    const deadline = setTimeout(() => process.exit(1), options.deadlineMs ?? 8000);
    options.controller.abort();
    shutdown = Promise.resolve().then(async () => {
      options.report(fatal);
      options.stop();
      try { await options.drain(); await options.close(); }
      catch { exitCode = 1; }
      finally { clearTimeout(deadline); process.exit(exitCode); }
    });
    return shutdown;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void terminate(); });
  process.on("uncaughtException", () => { void terminate(true); });
  process.on("unhandledRejection", () => { void terminate(true); });
  return terminate;
}
