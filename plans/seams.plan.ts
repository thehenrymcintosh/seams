// seams, mapped with seams. Read-only: how the tool is put together today.

import type { PlanDocument } from "../src/doc.ts";
import { contract, module, plan, port, query, record, rpc, src, stub, t } from "../src/dsl.ts";

const op = (name: string, input: Record<string, ReturnType<typeof t.ref>>, out: ReturnType<typeof t.ref>, path: string, symbol: string, line: number) =>
  query(name, input, out, [], { sources: [src(path, symbol, line)] });
const plan_ = t.ref("Model.Plan"), doc = t.ref("Model.PlanDocument"), text = t.string;

const model = module("Model", {
  purpose: "The plan's node types, the helpers plans are written with, stable node ids, and the tree walk every other part uses.",
  sources: [src("src/ast.ts"), src("src/dsl.ts"), src("src/ids.ts"), src("src/walk.ts"), src("src/doc.ts")],
  provides: [contract("Model", {
    sources: [src("src/ast.ts", "Plan"), src("src/doc.ts", "PlanDocument")],
    note: "The contract is the types themselves: every other module imports ast.ts and doc.ts directly.",
    types: [record("Plan", { name: t.string }), record("PlanDocument", { title: t.string }), record("Placed", { path: t.string })],
    operations: [op("Walk", { plan: plan_ }, t.ref("Placed"), "src/walk.ts", "walk", 9)],
  })],
});

const storage = module("Storage", {
  purpose: "Decides which key or index serves each lookup, and what column type a field gets.",
  sources: [src("src/storage.ts")],
  uses: ["Model"],
  provides: [contract("Storage", {
    operations: [
      op("AccessPatterns", { module: t.ref("Model.Plan") }, t.ref("Access"), "src/storage.ts", "accessPatterns", 27),
      op("SqlType", { type: t.ref("Model.Plan") }, text, "src/storage.ts", "sqlType", 87),
    ],
    types: [record("Access", { label: t.string, servedBy: t.optional(t.string) })],
  })],
});

const rules = module("Rules", {
  purpose: "The checker: whether a plan is consistent with itself. Boundaries, cycles, storage, endpoints, wiring, signals, tests.",
  sources: [src("src/check.ts")],
  uses: ["Model", "Storage"],
  provides: [contract("Rules", {
    types: [record("Diagnostic", { level: t.string, at: t.string, message: t.string })],
    operations: [
      op("Check", { plan: t.ref("Model.Plan") }, t.ref("Diagnostic"), "src/check.ts", "check", 49),
      op("IndexPlan", { plan: t.ref("Model.Plan") }, t.ref("Model.Plan"), "src/check.ts", "indexPlan", 17),
      op("DependencyGraph", { plan: t.ref("Model.Plan") }, t.ref("Model.Plan"), "src/check.ts", "dependencyGraph", 36),
    ],
  })],
});

const verifier = module("Verify", {
  purpose: "Holds one tree of a plan to a repository: sources, imports between module folders, the Prisma schema, operations.",
  sources: [src("src/verify.ts")],
  uses: ["Model", "Rules"],
  ports: [port("Files", "Reads the repository being verified.", ["readdirSync", "readFileSync", "statSync"], { prod: "node:fs" },
    { injected: false, sources: [src("src/verify.ts", "Repo")], note: "Repo wraps node:fs directly; a test needs a fixture folder on disk." })],
  provides: [contract("Verify", {
    types: [record("Finding", { level: t.string, at: t.string, message: t.string })],
    operations: [op("Verify", { plan: t.ref("Model.Plan"), root: text }, t.ref("Finding"), "src/verify.ts", "verify", 26)],
  })],
});

const views = module("Views", {
  purpose: "Everything derived from a plan as text: the cost-tagged diff, the agent outline, the code skeleton, the spec and Mermaid diagrams.",
  sources: [src("src/views/")],
  uses: ["Model", "Rules", "Storage"],
  note: "diff.ts borrows typeLabel from mermaid.ts. There are four type printers: mermaid typeLabel, outline ts(), viewmodel toks() and the skeleton's Scope.ts().",
  provides: [contract("Views", {
    operations: [
      op("Diff", { before: plan_, after: plan_ }, t.ref("Change"), "src/views/diff.ts", "diff", 19),
      op("Outline", { doc }, text, "src/views/outline.ts", "outline", 21),
      op("Skeleton", { plan: plan_ }, text, "src/views/skeleton.ts", "skeleton", 45),
      op("Spec", { plan: plan_ }, text, "src/views/spec.ts", "spec", 9),
      op("SystemDiagram", { plan: plan_ }, text, "src/views/mermaid.ts", "systemDiagram", 8),
    ],
    types: [record("Change", { tag: t.string, what: t.string, node: t.string })],
  })],
});

const page = module("Page", {
  purpose: "Turns a document into one self-contained HTML page, and reads the document back out of it.",
  sources: [src("src/render/")],
  uses: ["Model", "Rules", "Views", "Storage"],
  note: "client.js is about 1,300 lines of hand-written DOM code with no tests; viewmodel.ts precomputes everything it draws.",
  provides: [contract("Page", {
    operations: [
      op("RenderDocument", { doc }, text, "src/render/render.ts", "renderDocument", 18),
      op("ReadDocument", { html: t.ref("Model.Plan") }, doc, "src/render/render.ts", "readDocument", 47),
    ],
  })],
});

const cli = module("Cli", {
  purpose: "The seams command. Loads a document from .ts, .json or .html and calls the other modules.",
  sources: [src("src/cli.ts"), src("install.sh")],
  uses: ["Model", "Rules", "Page", "Views", "Verify"],
  ports: [port("Git", "Pulls the latest version for `seams update`.", ["pull --ff-only", "rev-parse --short HEAD"], { prod: "git (execFileSync)" },
    { injected: false, sources: [src("src/cli.ts", "execFileSync")] })],
  endpoints: ["new", "where", "update", "render", "check", "read", "verify"].map((c) =>
    rpc("cli", `seams ${c}`, c === "verify" ? "Verify.Verify" : c === "check" ? "Rules.Check" : c === "render" ? "Page.RenderDocument" : c === "read" ? "Page.ReadDocument" : "Model.Walk",
      { auth: "none", audience: "public", sources: [src("src/cli.ts", `"${c}"`)] })),
});

const skill = stub("Skill", "Tells the agent how to map a repo into a plan, check it, verify it and build from it.", [], [src("skills/seams/SKILL.md")]);
const examples = stub("Examples", "The worked shop example and the Documenso plan, and run.ts which regenerates out/.", [],
  [src("examples/"), src("plans/documenso-delegation.plan.ts"), src("run.ts")], ["Rules", "Views", "Page"]);

const current = plan("seams", [model, storage, rules, verifier, views, page, cli, skill, examples]);

const document: PlanDocument = {
  format: "plan-doc/1",
  title: "seams, mapped with seams",
  intent: "Use seams on its own repo to see what can be made better.",
  mode: "learn",
  current,
  slices: [],
  questions: [],
  decisions: [],
  facts: {
    Page: [{ label: "client.js lines", value: 1233, detail: "wc -l src/render/client.js" }, { label: "tests", value: 0, detail: "no test files in the repo" }],
    Model: [{ label: "`?? []` fallbacks outside dsl.ts", value: 57, detail: "grep -c '?? \\[\\]' src/**/*.ts, minus dsl.ts. Optional module fields (ports, signals, tests, gaps) are defended everywhere they are read." }],
    Views: [{ label: "type printers", value: 4, detail: "mermaid typeLabel, outline ts(), viewmodel toks(), skeleton Scope.ts()" }],
    Rules: [{ label: "tests", value: 0, detail: "rules are exercised only by run.ts on the examples" }],
    Verify: [{ label: "tests", value: 0, detail: "checked by hand against Documenso and this repo" }],
  },
};

export default document;
