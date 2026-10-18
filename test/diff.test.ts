import assert from "node:assert/strict";
import { test } from "node:test";
import { command, contract, http, metric, module, plan } from "../src/dsl.ts";
import { diff } from "../src/views/diff.ts";
import v1 from "../examples/shop.v1.ts";
import v2 from "../examples/shop.v2.ts";

const tagged = (a: Parameters<typeof diff>[0], b: Parameters<typeof diff>[1]) => diff(a, b).map((c) => `${c.tag} ${c.module}: ${c.what}`);

test("the worked change is tagged by cost", () => {
  const cs = tagged(v1, v2);
  assert.ok(cs.some((c) => /^additive Payments: new module/.test(c)));
  assert.ok(cs.some((c) => /^migration Orders: Order: add column paymentId/.test(c)));
  assert.ok(cs.some((c) => /^additive Orders: new endpoint GET \/orders\/\{id\}\/payment/.test(c)));
  assert.ok(cs.some((c) => /^additive Orders: new metric orders_placed_total/.test(c)));
  assert.ok(cs.some((c) => /^internal Orders: new unit test/.test(c)));
  // Order status changes shape, so consumers of the Orders contract must change too.
  assert.ok(cs.some((c) => /^breaking Orders: .*OrderStatus loses value "Placed"/.test(c)));
  assert.ok(cs.some((c) => /^breaking Orders: .*CancelOrder: can now fail with AlreadyPaid/.test(c)));
});

const svc = (o: Partial<Parameters<typeof module>[1]>) => plan("p", [module("Svc", {
  purpose: "x",
  provides: [contract("Svc", { operations: [command("Do", {}, null)] })],
  ...o,
})]);

test("removing an endpoint, tightening its auth, or dropping a metric breaks someone", () => {
  const ep = (auth: string) => http("POST", "/do", "Svc.Do", { auth });
  assert.ok(tagged(svc({ endpoints: [ep("session")] }), svc({})).some((c) => /^breaking .*endpoint POST \/do removed/.test(c)));
  assert.ok(tagged(svc({ endpoints: [ep("public")] }), svc({ endpoints: [ep("session")] })).some((c) => /^breaking .*auth public → session/.test(c)));
  assert.ok(tagged(svc({ signals: [metric("svc_total", "Svc.Do", ["outcome"])] }), svc({})).some((c) => /^breaking .*metric svc_total removed/.test(c)));
});

test("an unchanged plan has no changes", () => {
  assert.deepEqual(diff(v2, v2), []);
});
