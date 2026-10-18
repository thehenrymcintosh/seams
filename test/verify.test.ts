import assert from "node:assert/strict";
import { test } from "node:test";
import { command, contract, entity, gap, idx, module, plan, src, store, t, table } from "../src/dsl.ts";
import { codeOnly, memoryFiles, verify } from "../src/verify.ts";

// Two modules in their own folders, a Prisma schema, and one import between them.
const repo = memoryFiles({
  "package.json": `{ "name": "app" }`,
  "src/orders/place.ts": `import { charge } from "../payments/charge.ts";\nexport function placeOrder() { return charge(); }\n`,
  "src/payments/charge.ts": `export function charge() {}\n`,
  "src/payments/gen.ts": "const tpl = `import x from \"../orders/place.ts\"`; // import y from \"../orders/place.ts\"\n",
  "prisma/schema.prisma": "model Order {\n  id String @id\n  customerId String\n  @@index([customerId])\n}\n",
});

const payments = module("Payments", {
  purpose: "x", sources: [src("src/payments/")],
  provides: [contract("Payments", { operations: [command("Charge", {}, null)] })],
});
const orders = (o: Partial<Parameters<typeof module>[1]> = {}) => module("Orders", {
  purpose: "x", sources: [src("src/orders/")],
  entities: [entity("Order", { id: t.string, customerId: t.string })],
  stores: [store("db", "postgres", [table("Order", "Order", { indexes: [idx("customerId")] })])],
  provides: [contract("Orders", { operations: [command("PlaceOrder", {}, null)] })],
  uses: ["Payments"],
  ...o,
});
const run = (...ms: ReturnType<typeof module>[]) => verify(plan("p", ms), repo).map((f) => `${f.level} ${f.at}: ${f.message}`);

test("a plan that matches the code is clean", () => {
  assert.deepEqual(run(orders(), payments), []);
});

test("an import with no declared dependency is drift, unless the plan names it as a gap", () => {
  assert.ok(run(orders({ uses: [] }), payments).some((f) => /^error Orders \/ uses: the code imports Payments \(1 import/.test(f)));
  assert.deepEqual(run(orders({ uses: [], gaps: [gap("Payments", "calls charge directly")] }), payments), []);
});

test("a gap the code no longer has is flagged", () => {
  const stale = module("Payments", { purpose: "x", sources: [src("src/payments/")], gaps: [gap("Orders", "old")] });
  assert.ok(run(orders(), stale).some((f) => /warning Payments \/ gap Orders: the code no longer imports Orders/.test(f)));
});

test("imports inside strings and comments don't count", () => {
  assert.ok(!run(orders(), payments).some((f) => f.includes("Payments / uses")));
  assert.equal(codeOnly("a // b\nc").split("\n").length, 2);
});

test("sources must exist and name real symbols, near the line given", () => {
  const p = (s: ReturnType<typeof src>) => run(orders({ sources: [src("src/orders/"), s] }), payments);
  assert.ok(p(src("src/missing.ts")).some((f) => /src\/missing.ts does not exist/.test(f)));
  assert.ok(p(src("src/orders/place.ts", "nope")).some((f) => /"nope" not found/.test(f)));
  assert.ok(p(src("src/orders/place.ts", "placeOrder", 40)).some((f) => /expected near line 40, found at src\/orders\/place.ts:2/.test(f)));
  assert.deepEqual(p(src("src/orders/place.ts", "placeOrder", 2)), []);
});

test("stores are held to schema.prisma", () => {
  const off = orders({
    entities: [entity("Order", { id: t.string, customerId: t.string, total: t.int })],
    stores: [store("db", "postgres", [table("Order", "Order", { indexes: [idx("total")] })])],
  });
  const fs = run(off, payments);
  assert.ok(fs.some((f) => /column total is not in model Order/.test(f)));
  assert.ok(fs.some((f) => /no index on \(total\) in model Order/.test(f)));
});

test("new operations must point at their code", () => {
  const before = plan("p", [orders(), payments]);
  const withOp = (sources?: ReturnType<typeof src>[]) => plan("p", [orders({
    provides: [contract("Orders", { operations: [command("PlaceOrder", {}, null), command("Refund", {}, null, [], { sources })] })],
  }), payments]);
  assert.ok(verify(withOp(), repo, before).some((f) => /Orders.Refund.*is new in this change; give it a src\(\)/.test(`${f.at} ${f.message}`)));
  assert.ok(verify(withOp([src("src/orders/place.ts", "placeOrder")]), repo, before).every((f) => !f.at.includes("Refund")));
});
