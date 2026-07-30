/**
 * PR15.1 follow-up — CLI signal / shutdown / failure tests.
 *
 * The CLI is exercised via `runCli` with an injected `CliDeps`
 * seam so we can:
 *   - capture SIGINT / SIGTERM handlers and invoke them
 *     synchronously against a real fixture handle;
 *   - force verify() to throw with a redaction-relevant
 *     error containing the fake token + fixture account ID;
 *   - assert stderr redaction structurally;
 *   - assert exitCode is finalised only after shutdown
 *     resolves.
 *
 * All assertions rely on promises / barriers / spies — no
 * timer-based races.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import {
  runCli,
  SIGINT_EXIT_CODE,
  SIGTERM_EXIT_CODE,
  type CliDeps,
} from "./cli.js";
import {
  startFixtureStack,
  FIXTURE_ACCOUNT_ID,
  type FixtureHandle,
} from "./fixture-stack.js";
import {
  FAKE_TOKEN,
  verifyFixtureWithHandle,
  type VerifyFixtureFlowResult,
} from "./harness.js";

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    setTimeout(() => finish(false), 500);
  });
}

interface RecordedCli {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exitCodes: number[];
  readonly signalHandlers: Map<"SIGINT" | "SIGTERM", () => void>;
}

function recordDeps(
  startStack: () => Promise<FixtureHandle>,
  verify: (stack: FixtureHandle) => Promise<VerifyFixtureFlowResult>,
): { deps: CliDeps; rec: RecordedCli } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  const deps: CliDeps = {
    startStack,
    verify,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    setExitCode: (code) => exitCodes.push(code),
    registerSignal: (sig, handler) => {
      // Preserve LAST handler if re-registered (production
      // never re-registers, but we keep tests robust).
      signalHandlers.set(sig, handler);
    },
  };
  return { deps, rec: { stdout, stderr, exitCodes, signalHandlers } };
}

describe("runCli — happy path", () => {
  it("normal success: stdout PASS line, exit 0, shutdown completed, ports closed", async () => {
    let capturedStack: FixtureHandle | null = null;
    const { deps, rec } = recordDeps(
      async () => {
        capturedStack = await startFixtureStack();
        return capturedStack;
      },
      (stack) => verifyFixtureWithHandle(stack),
    );
    const result = await runCli(deps);
    assert.equal(result.outcome, "pass");
    assert.equal(result.exitCode, 0);
    assert.equal(result.shutdownCompleted, true);
    assert.equal(rec.exitCodes.at(-1), 0);
    assert.equal(rec.stdout.length, 1);
    assert.match(rec.stdout[0], /paper-verify-stack fixture: PASS/);
    assert.match(rec.stdout[0], /opt-out=13 requests/);
    assert.match(rec.stdout[0], /opt-in=14 requests/);
    assert.equal(rec.stderr.length, 0);
    assert.ok(capturedStack, "stack must have been created");
    // Types: the closed-over binding cannot be widened past
    // "handle | null" for the compiler.
    const s = capturedStack as unknown as FixtureHandle;
    assert.equal(s.isShutdown(), true);
    assert.equal(await isPortListening(s.ports.ingestion), false);
    assert.equal(await isPortListening(s.ports.signal), false);
    assert.equal(await isPortListening(s.ports.execution), false);
  });
});

describe("runCli — signal shutdown", () => {
  async function withInterrupt(
    sig: "SIGINT" | "SIGTERM",
    expectedCode: number,
  ): Promise<void> {
    let capturedStack: FixtureHandle | null = null;
    // Barrier that verify() awaits so the test can trigger
    // the signal at a deterministic moment (fixture up,
    // verification in flight).
    let releaseVerify!: () => void;
    const verifyPending = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    const { deps, rec } = recordDeps(
      async () => {
        capturedStack = await startFixtureStack();
        return capturedStack;
      },
      async (): Promise<VerifyFixtureFlowResult> => {
        await verifyPending;
        // Return an "empty" result; the CLI must NOT reach
        // this because the signal handler set `terminated`
        // before we resume.
        return {
          optOut: {
            mode: "opt-out",
            exitCode: 0,
            output: "{}",
            requests: [],
          },
          optIn: {
            mode: "opt-in",
            exitCode: 0,
            output: "{}",
            requests: [],
          },
        };
      },
    );
    const runPromise = runCli(deps);
    // Wait until the handler is registered and the fixture
    // is up (i.e. startStack resolved). We do this by
    // waiting a microtask until signalHandlers is populated
    // AND capturedStack is non-null.
    while (!rec.signalHandlers.has(sig) || capturedStack === null) {
      await new Promise((r) => setImmediate(r));
    }
    // Fire the signal, then release verify.
    rec.signalHandlers.get(sig)!();
    releaseVerify();
    const result = await runPromise;
    assert.equal(result.outcome, "terminated");
    assert.equal(result.exitCode, expectedCode);
    assert.equal(result.shutdownCompleted, true);
    // Exit code was set by the signal handler synchronously
    // BEFORE `runCli` resolved.
    assert.deepEqual(rec.exitCodes, [expectedCode]);
    // No PASS line — the whole point of the guard.
    assert.equal(
      rec.stdout.some((l) => l.includes("PASS")),
      false,
      `PASS line must NOT be emitted after ${sig}`,
    );
    assert.ok(capturedStack, "stack must have been created");
    const s = capturedStack as unknown as FixtureHandle;
    assert.equal(s.isShutdown(), true);
    assert.equal(await isPortListening(s.ports.ingestion), false);
    assert.equal(await isPortListening(s.ports.signal), false);
    assert.equal(await isPortListening(s.ports.execution), false);
  }

  it("SIGINT → exit 130, shutdown completes before finalising, no PASS emitted", async () => {
    await withInterrupt("SIGINT", SIGINT_EXIT_CODE);
  });

  it("SIGTERM → exit 143, shutdown completes before finalising, no PASS emitted", async () => {
    await withInterrupt("SIGTERM", SIGTERM_EXIT_CODE);
  });

  it("two consecutive signals result in exactly one exit-code assignment (first signal wins)", async () => {
    let capturedStack: FixtureHandle | null = null;
    let releaseVerify!: () => void;
    const verifyPending = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    const { deps, rec } = recordDeps(
      async () => {
        capturedStack = await startFixtureStack();
        return capturedStack;
      },
      async (): Promise<VerifyFixtureFlowResult> => {
        await verifyPending;
        return {
          optOut: {
            mode: "opt-out",
            exitCode: 0,
            output: "{}",
            requests: [],
          },
          optIn: {
            mode: "opt-in",
            exitCode: 0,
            output: "{}",
            requests: [],
          },
        };
      },
    );
    const runPromise = runCli(deps);
    while (!rec.signalHandlers.has("SIGINT") || capturedStack === null) {
      await new Promise((r) => setImmediate(r));
    }
    rec.signalHandlers.get("SIGINT")!();
    // Second signal MUST be a no-op.
    rec.signalHandlers.get("SIGTERM")!();
    releaseVerify();
    const result = await runPromise;
    assert.equal(result.outcome, "terminated");
    assert.equal(result.exitCode, SIGINT_EXIT_CODE);
    // Exactly one setExitCode call — 130 (SIGINT). SIGTERM
    // is dropped.
    assert.deepEqual(rec.exitCodes, [SIGINT_EXIT_CODE]);
    assert.equal(
      rec.stdout.some((l) => l.includes("PASS")),
      false,
    );
  });

  it("signal during startup: shutdown runs once startStack resolves; no PASS emitted", async () => {
    let releaseStartup!: () => void;
    const startupPending = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    let capturedStack: FixtureHandle | null = null;
    const { deps, rec } = recordDeps(
      async () => {
        await startupPending;
        capturedStack = await startFixtureStack();
        return capturedStack;
      },
      (stack) => verifyFixtureWithHandle(stack),
    );
    const runPromise = runCli(deps);
    // Wait until the signal handler is registered (it is
    // registered synchronously before `await startStack()`).
    while (!rec.signalHandlers.has("SIGINT")) {
      await new Promise((r) => setImmediate(r));
    }
    // Fire signal BEFORE startStack resolves.
    rec.signalHandlers.get("SIGINT")!();
    // Now let startup complete.
    releaseStartup();
    const result = await runPromise;
    assert.equal(result.outcome, "terminated");
    assert.equal(result.exitCode, SIGINT_EXIT_CODE);
    assert.equal(result.shutdownCompleted, true);
    assert.equal(
      rec.stdout.some((l) => l.includes("PASS")),
      false,
    );
    assert.ok(capturedStack, "stack must have been created");
    const s = capturedStack as unknown as FixtureHandle;
    assert.equal(s.isShutdown(), true);
    assert.equal(await isPortListening(s.ports.ingestion), false);
    assert.equal(await isPortListening(s.ports.signal), false);
    assert.equal(await isPortListening(s.ports.execution), false);
  });
});

describe("runCli — failure paths (genuine deterministic throws)", () => {
  it("verify() throws with token+account-ID in message → stderr redacted, exit 1, ports closed", async () => {
    let capturedStack: FixtureHandle | null = null;
    const injectedError = new Error(
      `injected verification failure: token=${FAKE_TOKEN} account=${FIXTURE_ACCOUNT_ID}`,
    );
    const { deps, rec } = recordDeps(
      async () => {
        capturedStack = await startFixtureStack();
        return capturedStack;
      },
      async () => {
        throw injectedError;
      },
    );
    const result = await runCli(deps);
    assert.equal(result.outcome, "fail");
    assert.equal(result.exitCode, 1);
    assert.equal(result.shutdownCompleted, true);
    assert.deepEqual(rec.exitCodes, [1]);
    assert.equal(rec.stdout.length, 0);
    assert.equal(rec.stderr.length, 1);
    // Structural redaction: neither the token nor the raw
    // account ID may appear in stderr.
    assert.equal(
      rec.stderr[0].includes(FAKE_TOKEN),
      false,
      `stderr leaked FAKE_TOKEN: ${rec.stderr[0]}`,
    );
    assert.equal(
      rec.stderr[0].includes(FIXTURE_ACCOUNT_ID),
      false,
      `stderr leaked FIXTURE_ACCOUNT_ID: ${rec.stderr[0]}`,
    );
    assert.match(rec.stderr[0], /\[REDACTED\]/);
    assert.match(rec.stderr[0], /DU-\*\*\*567/);
    assert.match(rec.stderr[0], /^paper-verify-stack:/);
    assert.ok(capturedStack, "stack must have been created");
    const s = capturedStack as unknown as FixtureHandle;
    assert.equal(s.isShutdown(), true);
    assert.equal(await isPortListening(s.ports.ingestion), false);
    assert.equal(await isPortListening(s.ports.signal), false);
    assert.equal(await isPortListening(s.ports.execution), false);
  });

  it("startStack() throws → no signal handler leak, no PASS, exit 1, no server to shut down", async () => {
    const { deps, rec } = recordDeps(
      async () => {
        throw new Error("simulated bind failure");
      },
      (stack) => verifyFixtureWithHandle(stack),
    );
    const result = await runCli(deps);
    assert.equal(result.outcome, "fail");
    assert.equal(result.exitCode, 1);
    // shutdownCompleted is still true — the flag reports
    // "the finally block ran and any owned stack was
    // closed"; here no stack was owned.
    assert.equal(result.shutdownCompleted, true);
    assert.deepEqual(rec.exitCodes, [1]);
    assert.equal(rec.stdout.length, 0);
    assert.equal(rec.stderr.length, 1);
    assert.match(rec.stderr[0], /simulated bind failure/);
  });
});
