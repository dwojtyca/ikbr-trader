import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PaperGuard, type ReadyProbe } from "./paper-guard.js";

function fakeProbe(
  result: Awaited<ReturnType<ReadyProbe["probeReady"]>>,
): ReadyProbe {
  return {
    async probeReady() {
      return result;
    },
  };
}

describe("PaperGuard — construction", () => {
  it("throws when probe is missing", () => {
    assert.throws(
      () =>
        new PaperGuard({
          // @ts-expect-error deliberate misuse
          probe: undefined,
          expectedEnvironment: "paper",
        }),
      /probe with probeReady\(\) is required/,
    );
  });

  it('refuses expectedEnvironment != "paper" defensively', () => {
    assert.throws(
      () =>
        new PaperGuard({
          probe: fakeProbe({
            kind: "ok",
            ready: true,
            environment: "paper",
            accountMatchesEnvironment: true,
          }),
          // @ts-expect-error deliberate misuse: PR13 must not allow live
          expectedEnvironment: "live",
        }),
      /expectedEnvironment must be "paper"/,
    );
  });
});

describe("PaperGuard.check", () => {
  it("passes when execution-engine reports paper + ready + account matches", async () => {
    const guard = new PaperGuard({
      probe: fakeProbe({
        kind: "ok",
        ready: true,
        environment: "paper",
        accountMatchesEnvironment: true,
      }),
      expectedEnvironment: "paper",
    });
    const result = await guard.check();
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined);
  });

  it('refuses when execution-engine reports environment="live"', async () => {
    const guard = new PaperGuard({
      probe: fakeProbe({
        kind: "ok",
        ready: true,
        environment: "live",
        accountMatchesEnvironment: true,
      }),
      expectedEnvironment: "paper",
    });
    const result = await guard.check();
    assert.equal(result.ok, false);
    assert.match(result.reason!, /environment="live"/);
  });

  it("refuses when ready = false", async () => {
    const guard = new PaperGuard({
      probe: fakeProbe({
        kind: "ok",
        ready: false,
        environment: "paper",
        accountMatchesEnvironment: true,
      }),
      expectedEnvironment: "paper",
    });
    const result = await guard.check();
    assert.equal(result.ok, false);
    assert.match(result.reason!, /not ready/i);
  });

  it("refuses when account does not match the paper whitelist", async () => {
    const guard = new PaperGuard({
      probe: fakeProbe({
        kind: "ok",
        ready: true,
        environment: "paper",
        accountMatchesEnvironment: false,
      }),
      expectedEnvironment: "paper",
    });
    const result = await guard.check();
    assert.equal(result.ok, false);
    assert.match(result.reason!, /paper whitelist/i);
  });

  it("refuses when the probe itself errors (fail-closed)", async () => {
    const guard = new PaperGuard({
      probe: fakeProbe({ kind: "error", message: "network down" }),
      expectedEnvironment: "paper",
    });
    const result = await guard.check();
    assert.equal(result.ok, false);
    assert.match(result.reason!, /network down/);
  });
});
