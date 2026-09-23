import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { ProposedOrder } from "@ikbr/shared";
import { registerCancelProposedRoute } from "./cancel-route.js";

const order: ProposedOrder = { id: 1, instrument: "TEST", side: "BUY", orderType: "LMT",
  quantity: 1, entry: 100, reason: "fixture", confidence: 1, timestamp: new Date().toISOString(),
  riskCheckStatus: "PASS", status: "SUBMITTED", brokerOrderId: "42" };

for (const failure of ["code=10147", "timeout", "disconnect"]) {
  test(`cancel ${failure} stays uncertain, retains order and requests reconciliation`, async () => {
    const app = Fastify(); let reconciliations = 0; let requests = 0;
    const persisted = structuredClone(order);
    registerCancelProposedRoute(app, {
      repository: { getProposedOrderById: async () => persisted },
      broker: { cancelBrokerOrder: async () => { requests++; throw new Error(failure); } },
      requestReconciliation: () => { reconciliations++; return Promise.reject(new Error("offline")); },
    });
    try {
      const res = await app.inject({ method: "POST", url: "/execution/cancel-proposed/1" });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, "CANCEL_UNCONFIRMED");
      assert.equal(persisted.status, "SUBMITTED");
      assert.equal(requests, 1); assert.equal(reconciliations, 1);
    } finally { await app.close(); }
  });
}
for (const status of ["CANCELLED", "PENDING_CANCEL"] as const) {
  test(`confirmed broker result ${status} is preserved without rewriting proposal`, async () => {
    const app = Fastify();
    registerCancelProposedRoute(app, {
      repository: { getProposedOrderById: async () => order },
      broker: { cancelBrokerOrder: async () => ({ brokerOrderId: "42", status }) },
      requestReconciliation: () => { assert.fail("unexpected request"); },
    });
    try {
      const res = await app.inject({ method: "POST", url: "/execution/cancel-proposed/1" });
      assert.equal(res.statusCode, 200); assert.equal(res.json().cancel.status, status);
      assert.equal(res.json().order.status, "SUBMITTED");
    } finally { await app.close(); }
  });
}
test("invalid ID and non-submitted proposal never call broker", async () => {
  const app = Fastify();
  registerCancelProposedRoute(app, {
    repository: { getProposedOrderById: async () => ({ ...order, status: "PROPOSED" }) },
    broker: { cancelBrokerOrder: async () => { assert.fail("broker call"); } }, requestReconciliation: () => {},
  });
  try {
    assert.equal((await app.inject({method:"POST",url:"/execution/cancel-proposed/invalid"})).statusCode,400);
    assert.equal((await app.inject({method:"POST",url:"/execution/cancel-proposed/1"})).statusCode,409);
  } finally { await app.close(); }
});
