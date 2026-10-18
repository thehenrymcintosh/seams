// plan CLI.
// A document is read from .json, from a rendered .html, or from a .ts file whose
// default export is the document (the form the plan skill writes).
//
//   node src/cli.ts render <doc.ts|doc.json|doc.html> [-o out.html] [--force]
//   node src/cli.ts read   <doc.html> [--outline] print the embedded document as JSON, or as the agent outline
//   node src/cli.ts check  <doc.json|doc.html>    run the checker on both trees

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { check, type Diagnostic } from "./check.ts";
import type { PlanDocument } from "./doc.ts";
import { readDocument, renderDocument } from "./render/render.ts";
import { outline } from "./views/outline.ts";

const [cmd, file, ...rest] = process.argv.slice(2);

async function load(path: string): Promise<PlanDocument> {
  if (path.endsWith(".ts")) return (await import(pathToFileURL(resolve(path)).href)).default as PlanDocument;
  const text = readFileSync(path, "utf8");
  return path.endsWith(".html") ? readDocument(text) : (JSON.parse(text) as PlanDocument);
}

function diagnostics(doc: PlanDocument): Diagnostic[] {
  const tag = (tree: string) => (d: Diagnostic) => ({ ...d, at: `${tree}: ${d.at}` });
  return [
    ...check(doc.current).map(tag("current")),
    ...(doc.proposed ? check(doc.proposed).map(tag("proposed")) : []),
  ];
}

const print = (ds: Diagnostic[]) => ds.forEach((d) => console.error(`${d.level.padEnd(7)} ${d.at}\n        ${d.message}`));

switch (cmd) {
  case "render": {
    const doc = await load(file);
    const ds = diagnostics(doc);
    print(ds);
    if (ds.some((d) => d.level === "error") && !rest.includes("--force")) {
      console.error("not rendered: fix the plan, or pass --force to render it with its errors shown");
      process.exit(1);
    }
    const o = rest.indexOf("-o");
    const out = o >= 0 ? rest[o + 1] : file.replace(/(\.plan)?\.(ts|json|html)$/, "") + ".plan.html";
    writeFileSync(out, renderDocument(doc));
    console.log(out);
    break;
  }
  case "read":
    console.log(rest.includes("--outline") ? outline(await load(file)) : JSON.stringify(await load(file), null, 2));
    break;
  case "check": {
    const ds = diagnostics(await load(file));
    print(ds);
    console.log(ds.length ? `${ds.length} finding(s)` : "clean");
    process.exit(ds.some((d) => d.level === "error") ? 1 : 0);
  }
  default:
    console.error("usage: plan render|read|check <file>");
    process.exit(2);
}
