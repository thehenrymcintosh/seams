import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "../src/check.ts";
import {
  audit, command, contract, entity, findBy, gap, get, metric, module, plan, port, repo, store, t, table, test as planTest,
} from "../src/dsl.ts";
import tangled from "../examples/shop.tangled.ts";
import v1 from "../examples/shop.v1.ts";
import v2 from "../examples/shop.v2.ts";

const messages = (p: Parameters<typeof check>[0]) => check(p).map((d) => `${d.level} ${d.at}: ${d.message}`);
const has = (p: Parameters<typeof check>[0], re: RegExp) => messages(p).some((m) => re.test(m));

test("the worked example is clean before and after", () => {
  assert.deepEqual(check(v1), []);
  assert.deepEqual(check(v2), []);
});

test("the tangled example breaks the boundary rules", () => {
  assert.ok(has(tangled, /error Orders -> Payments -> Orders: dependency cycle/));
  assert.ok(has(tangled, /error Orders \/ uses Gateway: reaches inside Payments/));
  assert.ok(has(tangled, /error Payments \/ OrderRepository: reaches into storage owned by Orders/));
  assert.ok(has(tangled, /exposes storage entity "Order"/));
});

// A module with one command, to hang wiring, signals and tests on.
const svc = (extra: Parameters<typeof module>[1] = { purpose: "" }) => plan("p", [module("Svc", {
  provides: [contract("Svc", { operations: [command("Do", {}, null)] })],
  ...extra,
  purpose: "does things",
})]);

test("a port the code imports directly is flagged, with how many tests fake it", () => {
  const hard = port("Clock", "time", ["now()"], { prod: "SystemClock" }, { injected: false });
  assert.ok(has(svc({ purpose: "", ports: [hard] }), /warning Svc \/ port Clock: is imported directly/));
  const faked = svc({ purpose: "", ports: [hard], tests: [planTest("a", "unit", "Svc.Do", { fakes: ["Clock"] }), planTest("b", "unit", "Svc.Do", { fakes: ["Clock"] })] });
  assert.ok(has(faked, /2 tests fake it, but the code imports it directly/));
});

test("an injected port faked without a test adapter is flagged", () => {
  const p = svc({ purpose: "", ports: [port("Clock", "time", ["now()"], { prod: "SystemClock" })], tests: [planTest("a", "unit", "Svc.Do", { fakes: ["Clock"] })] });
  assert.ok(has(p, /1 test fake it, but it has no test adapter yet/));
});

test("signals must hang off something real and leak nothing", () => {
  const p = svc({
    purpose: "",
    signals: [
      metric("svc_total", "Svc.Do", ["userId"]),
      audit("svc did", "Svc.Do", ["accessToken"]),
      metric("ghost", "Svc.Nope", []),
    ],
  });
  assert.ok(has(p, /label "userId" has one value per record/));
  assert.ok(has(p, /field "accessToken" may put a secret into telemetry/));
  assert.ok(has(p, /error Svc \/ metric ghost: "Svc.Nope" is not an operation/));
});

test("tests may only cover and fake what the module has", () => {
  const p = svc({ purpose: "", tests: [planTest("x", "unit", "Svc.Missing", { fakes: ["Mailer"] })] });
  assert.ok(has(p, /covers "Svc.Missing", which this module doesn't have/));
  assert.ok(has(p, /fakes "Mailer", which is not a port or a contract this module uses/));
});

test("a gap must name another module", () => {
  assert.ok(has(svc({ purpose: "", gaps: [gap("Nowhere", "x")] }), /error Svc \/ gap Nowhere: no other module named Nowhere/));
});

test("lookups with no index: a warning in SQL, an error in DynamoDB", () => {
  const withStore = (engine: "postgres" | "dynamodb") => plan("p", [module("Svc", {
    purpose: "x",
    entities: [entity("Thing", { id: t.uuid, owner: t.uuid })],
    repositories: [repo("Thing", [get, findBy("owner")])],
    stores: [store("db", engine, [table("Thing", "things", engine === "dynamodb" ? { pk: "T#{id}" } : {})])],
    provides: [contract("Svc", { operations: [] })],
  })]);
  assert.ok(has(withStore("postgres"), /warning .*findBy owner has no index on table "things".*full table scan/));
  assert.ok(messages(withStore("dynamodb")).some((m) => m.startsWith("error") && /findBy owner/.test(m)));
});
