#!/usr/bin/env node
// The seams CLI.
// A document is read from .json, from a rendered .html, or from a .ts file whose
// default export is the document (the form the plan skill writes).
//
//   seams new    <slug> [--learn]                 start plans/<slug>.plan.ts from a template
//   seams where                                  print the folder seams is installed in
//   seams update                                 pull the latest version into that folder
//   seams skeleton <doc> [-o <dir>]                write a typed code skeleton for the proposed tree
//   seams verify <doc> [--tree current|proposed] [--repo <dir>]
//                                                hold one tree of the plan to the code in a repository
//   node src/cli.ts render <doc.ts|doc.json|doc.html> [-o out.html] [--force]
//   node src/cli.ts read   <doc.html> [--outline] print the embedded document as JSON, or as the agent outline
//   node src/cli.ts check  <doc.json|doc.html>    run the checker on both trees

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, type Diagnostic } from "./check.ts";
import type { PlanDocument } from "./doc.ts";
import { normalizeDocument } from "./normalize.ts";
import { readDocument, renderDocument } from "./render/render.ts";
import { verify } from "./verify.ts";
import { outline } from "./views/outline.ts";
import { skeleton } from "./views/skeleton.ts";

// Flags may come before or after the file: `seams new --learn foo` and
// `seams new foo --learn` mean the same. A flag that takes a value keeps it.
const VALUED = new Set(["-o", "--tree", "--repo"]);
const args = process.argv.slice(2);
const positional: string[] = [], rest: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith("-")) positional.push(args[i]);
  else if (VALUED.has(args[i])) rest.push(args[i], args[++i]);
  else rest.push(args[i]);
}
const [cmd, file] = positional;

async function load(path: string): Promise<PlanDocument> {
  if (path.endsWith(".ts")) return normalizeDocument((await import(pathToFileURL(resolve(path)).href)).default as PlanDocument);
  const text = readFileSync(path, "utf8");
  return normalizeDocument(path.endsWith(".html") ? readDocument(text) : (JSON.parse(text) as PlanDocument));
}

function diagnostics(doc: PlanDocument): Diagnostic[] {
  const tag = (tree: string) => (d: Diagnostic) => ({ ...d, at: `${tree}: ${d.at}` });
  return [
    ...check(doc.current).map(tag("current")),
    ...(doc.proposed ? check(doc.proposed).map(tag("proposed")) : []),
  ];
}

const print = (ds: Diagnostic[]) => ds.forEach((d) => console.error(`${d.level.padEnd(7)} ${d.at}\n        ${d.message}`));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A new plan document with the imports and every section in place.
function template(slug: string, learn: boolean): string {
  const lib = (f: string) => pathToFileURL(resolve(ROOT, "src", f)).href;
  const title = slug.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  return `import type { PlanDocument } from "${lib("doc.ts")}";
import {
  aggregate, audit, command, contract, entity, enumOf, event, findBy, get, http, idx, log, metric, module, plan, port, query,
  record, repo, rpc, save, src, store, stub, subscribe, t, table, test, trace, uniqueIdx,
} from "${lib("dsl.ts")}";

// Map the modules the intent touches here; name everything else with stub().
const current = plan("system", [
  stub("Example", "Replace with a real module."),
]);

const doc: PlanDocument = {
  format: "plan-doc/1",
  title: ${JSON.stringify(title)},
  intent: "What the user asked for, in their words.",
  mode: ${JSON.stringify(learn ? "learn" : "plan")},
  current,${learn ? "" : "\n  proposed: current, // replace the modules that change"}
  slices: [],
  questions: [],
  decisions: [],
  facts: {},
  glossary: [],
};

export default doc;
`;
}

switch (cmd) {
  case "where":
    console.log(ROOT);
    break;
  case "update": {
    if (!existsSync(resolve(ROOT, ".git"))) { console.error(`${ROOT} is not a git clone; reinstall with install.sh`); process.exit(1); }
    const head = () => execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const before = head();
    execFileSync("git", ["-C", ROOT, "pull", "--ff-only", "--quiet"], { stdio: "inherit" });
    console.log(before === head() ? `seams is up to date (${before})` : `Updated seams ${before} -> ${head()}`);
    break;
  }
  case "new": {
    if (!file) { console.error("usage: seams new <slug> [--learn]"); process.exit(2); }
    const out = resolve("plans", `${file}.plan.ts`);
    if (existsSync(out)) { console.error(`${out} already exists`); process.exit(1); }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, template(file, rest.includes("--learn")));
    console.log(out);
    break;
  }
  case "render": {
    if (!file) { console.error("usage: seams render <plan> [-o out.html] [--force]"); process.exit(2); }
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
  case "skeleton": {
    if (!file) { console.error("usage: seams skeleton <plan> [-o <dir>]"); process.exit(2); }
    const doc = await load(file);
    const o = rest.indexOf("-o");
    const dir = o >= 0 ? rest[o + 1] : file.replace(/(\.plan)?\.(ts|json|html)$/, "") + ".skeleton";
    const files = skeleton(doc.proposed ?? doc.current);
    for (const [path, text] of files) {
      const target = resolve(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    console.log(`${files.size} files in ${dir}`);
    break;
  }
  case "verify": {
    if (!file) { console.error("usage: seams verify <plan> [--tree current|proposed] [--repo <dir>]"); process.exit(2); }
    const doc = await load(file);
    const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
    const which = flag("--tree") ?? "current";
    if (which !== "current" && which !== "proposed") { console.error(`--tree is current or proposed, not ${which}`); process.exit(2); }
    const tree = which === "proposed" ? doc.proposed : doc.current;
    if (!tree) { console.error(`this plan has no ${which} tree`); process.exit(2); }
    const repo = flag("--repo") ?? process.cwd();
    const fs = verify(tree, repo, which === "proposed" ? doc.current : undefined);
    print(fs.map((f) => ({ ...f, at: `${which}: ${f.at}` })));
    console.log(fs.length ? `${fs.length} finding(s) against ${resolve(repo)}` : `the ${which} tree matches ${resolve(repo)}`);
    process.exit(fs.some((f) => f.level === "error") ? 1 : 0);
  }
  case "check": {
    const ds = diagnostics(await load(file));
    print(ds);
    console.log(ds.length ? `${ds.length} finding(s)` : "clean");
    process.exit(ds.some((d) => d.level === "error") ? 1 : 0);
  }
  default:
    console.error("usage: seams new <slug> | seams render|check|read <file> | seams verify|skeleton <file> | seams where | seams update");
    process.exit(2);
}
