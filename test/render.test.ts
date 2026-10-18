import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanDocument } from "../src/doc.ts";
import { normalizeDocument } from "../src/normalize.ts";
import { readDocument, renderDocument } from "../src/render/render.ts";
import { typeLabel } from "../src/types.ts";
import { outline } from "../src/views/outline.ts";
import { t } from "../src/dsl.ts";
import shop from "../examples/shop.doc.ts";

test("a rendered page carries the document, and reads back the same", () => {
  const html = renderDocument(shop);
  assert.match(html, /<meta name="generator" content="seams">/);
  assert.deepEqual(readDocument(html), JSON.parse(JSON.stringify(normalizeDocument(shop))));
});

test("an older document missing newer parts loads with them filled in", () => {
  const old = JSON.parse(JSON.stringify(shop)) as PlanDocument;
  for (const m of old.current.modules) {
    delete (m as Partial<typeof m>).ports; delete (m as Partial<typeof m>).gaps;
    for (const st of m.stores) for (const b of st.holds) delete (b as Partial<typeof b>).gsis;
  }
  const doc = normalizeDocument(old);
  for (const m of doc.current.modules) {
    assert.deepEqual(m.ports, []);
    assert.deepEqual(m.gaps, []);
    for (const st of m.stores) for (const b of st.holds) assert.deepEqual(b.gsis, []);
  }
  assert.doesNotThrow(() => renderDocument(old));
});

test("the outline states the rules and every node by id", () => {
  const o = outline(shop);
  assert.match(o, /# rules the code must follow:/);
  assert.match(o, /seams verify <plan> --tree proposed/);
  assert.match(o, /module \[Payments\]/);
  assert.match(o, /cmd \[Payments\/contract\/Payments\/StartPayment\]/);
});

test("types print one way, with a choice of how optional reads", () => {
  const ty = t.list(t.optional(t.ref("Order")));
  assert.equal(typeLabel(ty), "Order?[]");
  assert.equal(typeLabel(ty, " | null"), "Order | null[]");
});
