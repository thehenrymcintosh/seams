// Renders a plan document to one self-contained HTML file. The page makes no
// network requests: styles, script and data are all inline.
//
// Three blocks are embedded:
//   #plan-doc      the document itself, the source of truth, read back by `seams read`
//   #plan-outline  the compact text an agent validates code against (views/outline.ts)
//   #plan-view     derived for drawing, ignored on read-back

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanDocument } from "../doc.ts";
import { outline } from "../views/outline.ts";
import { viewOf } from "./viewmodel.ts";

const here = import.meta.dirname;
const asset = (name: string) => readFileSync(join(here, name), "utf8");

export function renderDocument(doc: PlanDocument): string {
  const view = viewOf(doc);
  return `<!doctype html>
<html lang="en" data-lavish-annotate="off">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="seams">
<title>${escapeHtml(doc.title)}</title>
<style>
${asset("client.css")}
</style>
</head>
<body>
<noscript><p class="noscript">This plan is drawn by an inline script. The plan data is in the #plan-doc block of this file.</p></noscript>
<div id="app"></div>
<script type="application/json" id="plan-doc">${json(doc)}</script>
<script type="text/plain" id="plan-outline">
${outline(doc).replace(/<\/script/gi, "<\\/script")}</script>
<script type="application/json" id="plan-view">${json(view)}</script>
<script>
${asset("client.js")}
</script>
</body>
</html>
`;
}

// Reads the document back out of a rendered page.
export function readDocument(html: string): PlanDocument {
  const m = html.match(/<script type="application\/json" id="plan-doc">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no #plan-doc block found; is this a rendered plan document?");
  return JSON.parse(m[1]) as PlanDocument;
}

// JSON inside <script> must not contain "</" or it ends the element early.
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
