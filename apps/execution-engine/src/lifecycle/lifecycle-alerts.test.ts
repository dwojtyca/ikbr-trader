import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTelegramLifecycleTransport } from "./lifecycle-alerts.js";

describe("Telegram lifecycle acknowledgement", () => {
  const make = (body: unknown, status = 200) => createTelegramLifecycleTransport({
    botToken: "test-token", chatId: "test-chat",
    fetch: async () => new Response(JSON.stringify(body), { status }),
  });

  it("accepts only ok:true with a positive message ID", async () => {
    assert.deepEqual(await make({ ok: true, result: { message_id: 42 } }).send("LF-1"), { status: "DELIVERED", messageId: "42" });
    for (const body of [{ ok: true }, { ok: false, result: { message_id: 42 } }, { ok: true, result: { message_id: 0 } }]) {
      assert.deepEqual(await make(body).send("LF-1"), body.ok === false
        ? { status: "FAILED", errorCode: "provider_rejected" }
        : { status: "UNKNOWN", errorCode: "provider_invalid_ack" });
    }
  });

  it("never returns response content, URL, token, or chat ID on failure", async () => {
    const response = await make({ description: "test-token test-chat private response" }, 403).send("LF-1");
    assert.deepEqual(response, { status: "UNKNOWN", errorCode: "provider_invalid_ack" });
    assert.doesNotMatch(JSON.stringify(response), /token|chat|private|telegram/);
  });

  it("disabled transport sends nothing", async () => {
    let calls = 0;
    const transport = createTelegramLifecycleTransport({ fetch: async () => { calls++; throw new Error("unexpected"); } });
    assert.equal(transport.enabled, false);
    assert.deepEqual(await transport.send("probe"), { status: "FAILED", errorCode: "transport_disabled" });
    assert.equal(calls, 0);
  });

  it("treats transport exceptions and oversized replies as uncertain", async () => {
    const thrown = createTelegramLifecycleTransport({ botToken: "secret", chatId: "chat", fetch: async () => { throw new Error("secret response body"); } });
    assert.deepEqual(await thrown.send("LF-1"), { status: "UNKNOWN", errorCode: "provider_request_uncertain" });
    const oversized = createTelegramLifecycleTransport({ botToken: "secret", chatId: "chat", fetch: async () => new Response("x".repeat(65_537)) });
    assert.deepEqual(await oversized.send("LF-1"), { status: "UNKNOWN", errorCode: "provider_response_oversize" });
  });

  it("ends a request that ignores cancellation at the five-second deadline", async () => {
    const transport = createTelegramLifecycleTransport({
      botToken: "secret", chatId: "chat",
      fetch: async () => new Promise<Response>(() => undefined),
    });
    const started = Date.now();
    assert.deepEqual(await transport.send("LF-1"), { status: "UNKNOWN", errorCode: "transport_timeout" });
    assert.ok(Date.now() - started < 7_000);
  });
});
