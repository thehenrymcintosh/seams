// Renders every view for the worked example into out/.
//   node run.ts

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, type Diagnostic } from "./src/check.ts";
import { diffReport } from "./src/views/diff.ts";
import { systemDiagram } from "./src/views/mermaid.ts";
import { skeleton } from "./src/views/skeleton.ts";
import { spec } from "./src/views/spec.ts";
import v1 from "./examples/shop.v1.ts";
import v2 from "./examples/shop.v2.ts";
import tangled from "./examples/shop.tangled.ts";
import shopDoc from "./examples/shop.doc.ts";
import { renderDocument } from "./src/render/render.ts";

const OUT = join(import.meta.dirname, "out");
rmSync(OUT, { recursive: true, force: true });
const write = (path: string, text: string) => {
  const p = join(OUT, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const report = (ds: Diagnostic[]) =>
  ds.length ? ds.map((d) => `${d.level.padEnd(7)} ${d.at}\n        ${d.message}`).join("\n") : "clean";

for (const [name, p] of [["v1", v1], ["v2", v2]] as const) {
  write(`${name}/plan.json`, JSON.stringify(p, null, 2));
  write(`${name}/system.mmd`, systemDiagram(p));
  write(`${name}/spec.md`, spec(p));
  console.log(`${name}: ${report(check(p))}`);
}
for (const [path, text] of skeleton(v2)) write(`v2/skeleton/${path}`, text);
write("change-v1-to-v2.md", diffReport(v1, v2));
write("tangled-check.txt", report(check(tangled)) + "\n");
console.log(`tangled:\n${report(check(tangled))}`);

write("shop-payments.plan.json", JSON.stringify(shopDoc, null, 2));
write("shop-payments.plan.html", renderDocument(shopDoc));
console.log(`plan document: ${report([...check(shopDoc.current), ...check(shopDoc.proposed!)])}`);
