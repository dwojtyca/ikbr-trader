/**
 * PR15.1 follow-up — reproducible fixture verification CLI.
 *
 * Runs the full fixture flow (opt-out then opt-in) against a
 * dynamic-port fixture stack. Prints a one-line summary and
 * exits `0` on success. Any assertion failure is redacted
 * through `formatFatalError` before hitting stderr and the
 * process exits `1`. Handles `SIGINT` / `SIGTERM` by closing
 * the fixture servers before exiting.
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
import { verifyFixtureFlow, FAKE_TOKEN } from "./harness.js";

async function main(): Promise<void> {
  // Register signal handlers early so a Ctrl-C during
  // fixture startup (a narrow window: three localhost
  // `listen(0)` calls) still cleanly exits without leaking
  // background servers. Because `verifyFixtureFlow` owns
  // the fixture handle we cannot invoke its shutdown from
  // here, but exiting the process releases all bound
  // sockets — which is the OS-level guarantee we need.
  const onSignal = (code: number) => (): void => {
    process.stderr.write(
      `paper-verify-stack fixture: signal received, exiting ${code}\n`,
    );
    process.exit(code);
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));

  try {
    const result = await verifyFixtureFlow();
    // Deterministic, redaction-safe summary.
    const line =
      `paper-verify-stack fixture: PASS ` +
      `(opt-out=${result.optOut.requests.length} requests, ` +
      `exit=${result.optOut.exitCode}; ` +
      `opt-in=${result.optIn.requests.length} requests, ` +
      `exit=${result.optIn.exitCode})`;
    process.stdout.write(`${line}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${formatFatalError(err, FAKE_TOKEN)}\n`);
    process.exit(1);
  }
}

void main();
