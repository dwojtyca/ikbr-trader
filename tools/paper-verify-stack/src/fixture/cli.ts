/**
 * PR15.1 follow-up — reproducible fixture verification CLI
 * with cooperative shutdown.
 *
 * The CLI explicitly owns the `FixtureHandle` (rather than
 * delegating to `verifyFixtureFlow`) so `SIGINT` / `SIGTERM`
 * handlers can `await stack.shutdown()` before the process
 * exits. `process.exit()` is never invoked; instead we set
 * `process.exitCode` and let the event loop drain naturally
 * once every server socket is closed.
 *
 * Wired as:
 *   pnpm --filter @ikbr/paper-verify-stack verify:fixture
 *   pnpm paper:verify-stack:fixture         (root convenience)
 *
 * The fixture is loopback-only and never contacts IBKR / the
 * real Docker Compose services. Safe to run while the paper
 * stack is up.
 */

import { formatFatalError } from "../index.js";
import {
  FAKE_TOKEN,
  verifyFixtureWithHandle,
  type VerifyFixtureFlowResult,
} from "./harness.js";
import {
  startFixtureStack,
  type FixtureHandle,
} from "./fixture-stack.js";

/**
 * Dependency seam so tests can drive the CLI's shutdown /
 * signal / success / failure paths deterministically without
 * touching real `process` state or spawning a child process.
 * The production entrypoint at the bottom of the file passes
 * the real Node bindings.
 */
export interface CliDeps {
  /** Create and return a fixture handle. */
  readonly startStack: () => Promise<FixtureHandle>;
  /** Run verification against a handle. Does NOT own it. */
  readonly verify: (stack: FixtureHandle) => Promise<VerifyFixtureFlowResult>;
  /** stdout sink (line-oriented). */
  readonly stdout: (line: string) => void;
  /** stderr sink (line-oriented). */
  readonly stderr: (line: string) => void;
  /** Set the process exit code. */
  readonly setExitCode: (code: number) => void;
  /** Register a signal handler. Handler is invoked synchronously. */
  readonly registerSignal: (
    sig: "SIGINT" | "SIGTERM",
    handler: () => void,
  ) => void;
}

/** Terminal exit codes for POSIX signal-triggered shutdown. */
export const SIGINT_EXIT_CODE = 130;
export const SIGTERM_EXIT_CODE = 143;

export interface RunCliResult {
  readonly outcome: "pass" | "fail" | "terminated";
  readonly exitCode: number;
  /** True once the fixture handle's shutdown has resolved. */
  readonly shutdownCompleted: boolean;
}

/**
 * Run the CLI to completion. Return the resolved outcome so
 * unit tests can observe it. The real entrypoint discards
 * the return value — only `deps.setExitCode` matters at the
 * OS boundary.
 */
export async function runCli(deps: CliDeps): Promise<RunCliResult> {
  let stack: FixtureHandle | null = null;
  let terminated = false;
  let terminationCode: number | null = null;

  // `stack.shutdown()` is itself idempotent (memoised inside
  // the fixture module), so no memo is needed here. We only
  // guard against invoking it when `stack` is still null,
  // which happens if a signal arrives during startup — in
  // that case we shut the stack down explicitly once it
  // finally resolves (see the try block below).
  const shutdownIfStarted = async (): Promise<void> => {
    if (stack !== null) {
      await stack.shutdown();
    }
  };

  const onSignal = (code: number) => (): void => {
    if (terminated) return;
    terminated = true;
    terminationCode = code;
    deps.setExitCode(code);
    // Kick off shutdown but never throw from a signal handler.
    // main's finally also awaits shutdown; both go through
    // the same idempotent `stack.shutdown()`.
    shutdownIfStarted().catch(() => {
      /* swallow — we are already terminating */
    });
  };
  deps.registerSignal("SIGINT", onSignal(SIGINT_EXIT_CODE));
  deps.registerSignal("SIGTERM", onSignal(SIGTERM_EXIT_CODE));

  let shutdownCompleted = false;
  let outcome: "pass" | "fail" | "terminated" = "fail";
  try {
    stack = await deps.startStack();
    // A signal may have arrived while `startStack` was
    // pending. The signal handler's own shutdown attempt saw
    // a null stack, so shut this one down explicitly.
    if (terminated) {
      return await finish("terminated");
    }
    const result = await deps.verify(stack);
    if (terminated) {
      // Signal fired during verification — do NOT emit PASS.
      return await finish("terminated");
    }
    deps.stdout(
      `paper-verify-stack fixture: PASS ` +
        `(opt-out=${result.optOut.requests.length} requests, ` +
        `exit=${result.optOut.exitCode}; ` +
        `opt-in=${result.optIn.requests.length} requests, ` +
        `exit=${result.optIn.exitCode})`,
    );
    deps.setExitCode(0);
    outcome = "pass";
  } catch (err) {
    deps.stderr(formatFatalError(err, FAKE_TOKEN));
    if (!terminated) {
      deps.setExitCode(1);
      outcome = "fail";
    } else {
      outcome = "terminated";
    }
  } finally {
    await shutdownIfStarted();
    shutdownCompleted = true;
  }
  return {
    outcome: terminated ? "terminated" : outcome,
    exitCode: terminated
      ? terminationCode ?? SIGTERM_EXIT_CODE
      : outcome === "pass"
        ? 0
        : 1,
    shutdownCompleted,
  };

  async function finish(
    kind: "terminated",
  ): Promise<RunCliResult> {
    await shutdownIfStarted();
    shutdownCompleted = true;
    return {
      outcome: kind,
      exitCode: terminationCode ?? SIGTERM_EXIT_CODE,
      shutdownCompleted,
    };
  }
}

// -------- production entrypoint --------

// Run only when this file is the Node entry point — not when
// imported by tests. Tests import symbols from `./cli.js`,
// so `runCli` must not fire on import.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(process.argv[1].replace(/^\//, "/")));

if (invokedDirectly) {
  void runCli({
    startStack: (): Promise<FixtureHandle> => startFixtureStack(),
    verify: (stack: FixtureHandle): Promise<VerifyFixtureFlowResult> =>
      verifyFixtureWithHandle(stack),
    stdout: (line: string): void => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string): void => {
      process.stderr.write(`${line}\n`);
    },
    setExitCode: (code: number): void => {
      process.exitCode = code;
    },
    registerSignal: (sig, handler): void => {
      process.on(sig, handler);
    },
  });
}
