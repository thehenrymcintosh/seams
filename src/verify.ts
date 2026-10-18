// Holds a plan to the code it describes. The checker asks whether a plan is
// consistent with itself; verify asks whether the repository agrees with it.
//
//   sources     every src() names a path that exists, and the symbol is in it
//   imports     code in one module's folders imports another module's code
//               only through a declared `uses`
//   schema      tables, columns and indexes in a store exist in schema.prisma
//   operations  each operation has code: its own src(), or something named
//               after it under its contract's or module's folders
//   gaps        a declared gap still exists in the code
//
// Run it on the current tree after mapping (the map is true) and on the
// proposed tree after building (the change is done and nothing drifted).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Located, Module, Plan } from "./ast.ts";
import { indexPlan } from "./check.ts";
import { walk } from "./walk.ts";

export type Finding = { level: "error" | "warning"; at: string; message: string };

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", "out"]);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// `baseline` is the tree the change starts from. Operations and endpoints that
// are new against it must point at their code with src(); a name match is
// not enough to say a new thing was built.
export function verify(plan: Plan, root: string, baseline?: Plan): Finding[] {
  const out: Finding[] = [];
  const err = (at: string, message: string) => out.push({ level: "error", at, message });
  const warn = (at: string, message: string) => out.push({ level: "warning", at, message });
  const repo = new Repo(root);
  const tree = walk(plan);
  const ix = indexPlan(plan);
  const before = baseline && walk(baseline);
  const oldOps = new Set(before?.flatMap((p) => p.module.provides.flatMap((c) => c.operations.map((o) => `${c.name}.${o.name}`))));
  const oldEndpoints = new Set(before?.flatMap((p) => p.module.endpoints.map((e) => `${p.path} ${e.name}`)));

  // --- sources
  const located: [string, Located][] = [];
  for (const { module: m, path } of tree) {
    located.push([path, m]);
    for (const e of m.entities) located.push([`${path} / ${e.name}`, e]);
    for (const c of m.provides) {
      located.push([`${path} / contract ${c.name}`, c]);
      for (const o of c.operations) located.push([`${path} / ${c.name}.${o.name}`, o]);
    }
    for (const st of m.stores) {
      located.push([`${path} / store ${st.name}`, st]);
      for (const b of st.holds) located.push([`${path} / table ${b.table}`, b]);
    }
    for (const x of m.endpoints) located.push([`${path} / endpoint ${x.name}`, x]);
    for (const x of m.ports ?? []) located.push([`${path} / port ${x.name}`, x]);
    for (const x of m.signals ?? []) located.push([`${path} / ${x.type} ${x.name}`, x]);
    for (const x of m.tests ?? []) {
      located.push([`${path} / test "${x.name}"`, x]);
      if (x.exists && !x.sources?.length) warn(`${path} / test "${x.name}"`, "marked as existing but has no src() pointing at it");
    }
  }
  for (const [at, node] of located) {
    for (const s of node.sources ?? []) {
      const where = `${s.path}${s.symbol ? ` (${s.symbol})` : ""}`;
      if (!repo.exists(s.path)) { err(at, `${s.path} does not exist`); continue; }
      if (!s.symbol) continue;
      const hits = repo.find(s.path, wordRe(s.symbol));
      if (!hits.length) { err(at, `${where}: "${s.symbol}" not found`); continue; }
      if (s.line && !hits.some((h) => h.file === s.path && Math.abs(h.line - s.line!) <= 15)) {
        const h = hits[0];
        warn(at, `${where}: expected near line ${s.line}, found at ${h.file}:${h.line}`);
      }
    }
  }

  // --- imports: who owns each file is decided by the most specific module source
  const owners: { dir: string; module: Module; path: string }[] = [];
  for (const { module: m, path } of tree) {
    for (const s of m.sources ?? []) if (repo.isDir(s.path)) owners.push({ dir: trim(s.path), module: m, path });
  }
  owners.sort((a, b) => b.dir.length - a.dir.length);
  const ownerOf = (file: string) => owners.find((o) => file === o.dir || file.startsWith(`${o.dir}/`));
  const seen = new Map<string, { count: number; example: string }>();
  const usedInCode = new Map<Module, Set<Module>>();
  const gapsSeen = new Set<object>();
  // A stub is named, not read, so its own imports aren't held to the plan.
  for (const o of owners.filter((x) => x.module.depth === "mapped")) {
    for (const file of repo.files(o.dir)) {
      if (!CODE.test(file) || ownerOf(file) !== o) continue;
      for (const imp of repo.imports(file)) {
        const target = repo.resolveImport(file, imp.spec);
        const t = target && ownerOf(target);
        if (!t || t.module === o.module) continue;
        if (!usedInCode.has(o.module)) usedInCode.set(o.module, new Set());
        usedInCode.get(o.module)!.add(t.module);
        if (allowed(o.module, t.module, tree, ix)) continue;
        const gap = (o.module.gaps ?? []).find((g) => g.module === t.module.name);
        if (gap) { gapsSeen.add(gap); continue; }
        const key = `${o.path} -> ${t.path}`;
        const prev = seen.get(key);
        seen.set(key, { count: (prev?.count ?? 0) + 1, example: prev?.example ?? `${file}:${imp.line} imports ${imp.spec}` });
      }
    }
  }
  for (const [key, { count, example }] of seen) {
    const [from, to] = key.split(" -> ");
    err(`${from} / uses`, `the code imports ${to} (${count} import${count === 1 ? "" : "s"}, e.g. ${example}) but the plan declares no dependency on it. Add the dependency, or a gap() if the plan leaves it out on purpose`);
  }
  for (const { module: m, path } of tree) {
    for (const g of m.gaps ?? []) {
      if (!ix.moduleByName.has(g.module)) err(`${path} / gap ${g.module}`, `no module named ${g.module}`);
      else if (!gapsSeen.has(g)) warn(`${path} / gap ${g.module}`, `the code no longer imports ${g.module}; remove the gap`);
    }
  }
  for (const { module: m, path } of tree) {
    if (m.depth !== "mapped" || !owners.some((o) => o.module === m)) continue;
    for (const u of m.uses) {
      const target = ix.contractOwner.get(u.contract);
      if (!target || u.subscribes.length || !owners.some((o) => o.module === target)) continue;
      const reached = usedInCode.get(m);
      const inside = (x: Module) => x === target || walk({ kind: "plan", name: "", modules: [target] }).some((p) => p.module === x);
      if (!reached || ![...reached].some(inside)) warn(`${path} / uses ${u.contract}`, `nothing in ${path}'s folders imports ${target.name}'s code`);
    }
  }

  if (before) {
    for (const { module: m, path } of tree) {
      for (const e of m.endpoints) {
        if (!oldEndpoints.has(`${path} ${e.name}`) && !e.sources?.length) {
          err(`${path} / endpoint ${e.name}`, "is new in this change; give it a src() pointing at the route that serves it");
        }
      }
    }
  }

  // --- schema
  const prisma = repo.prismaModels();
  if (prisma.size) {
    for (const { module: m, path } of tree) {
      for (const st of m.stores) {
        if (!["postgres", "mysql", "sqlite"].includes(st.engine)) continue;
        for (const b of st.holds) {
          const at = `${path} / table ${b.table}`;
          const model = prisma.get(b.table);
          if (!model) { err(at, `no model ${b.table} in schema.prisma`); continue; }
          const e = m.entities.find((x) => x.name === b.entity);
          for (const f of e?.fields ?? []) {
            const col = b.columns?.find((c) => c.field === f.name)?.column ?? f.name;
            if (!model.fields.has(col)) err(at, `column ${col} is not in model ${b.table}`);
          }
          for (const i of b.indexes ?? []) {
            const key = i.on.join(",");
            if (!model.indexes.has(key)) err(at, `no index on (${i.on.join(", ")}) in model ${b.table}`);
          }
        }
      }
    }
  }

  // --- operations: the code has something named after each one
  for (const { module: m, path } of tree) {
    if (m.depth !== "mapped") continue;
    for (const c of m.provides) {
      const dirs = [...(c.sources ?? []), ...(m.sources ?? [])].map((s) => s.path).filter((p) => repo.exists(p));
      if (!dirs.length) continue;
      for (const o of c.operations) {
        if (o.sources?.length) continue;
        if (before && !oldOps.has(`${c.name}.${o.name}`)) {
          err(`${path} / ${c.name}.${o.name}`, "is new in this change; give it a src() pointing at the code that implements it");
          continue;
        }
        const re = new RegExp(o.name.split(/(?=[A-Z])/).join("[\\w-]*"), "i");
        if (!dirs.some((d) => repo.anyPathOrLine(d, re))) {
          err(`${path} / ${c.name}.${o.name}`, `can't find code for it under ${dirs.join(", ")}; give the operation a src()`);
        }
      }
    }
  }
  return out;
}

// An import across modules is fine when the importer declares a dependency on
// a contract the target provides, or the target is a module it sits inside.
function allowed(from: Module, to: Module, tree: ReturnType<typeof walk>, ix: ReturnType<typeof indexPlan>): boolean {
  if (from.uses.some((u) => ix.contractOwner.get(u.contract) === to)) return true;
  const placed = tree.find((p) => p.module === from);
  return !!placed?.ancestors.includes(to);
}

const trim = (p: string) => p.replace(/\/+$/, "");
const wordRe = (s: string) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

// The repository, read lazily and cached: file lists, contents, packages.
class Repo {
  root: string;
  private text = new Map<string, string[]>();
  private lists = new Map<string, string[]>();
  private packages: Map<string, string> | null = null;
  constructor(root: string) { this.root = resolve(root); }

  exists(p: string) { return existsSync(join(this.root, p)); }
  isDir(p: string) { return this.exists(p) && statSync(join(this.root, p)).isDirectory(); }

  files(p: string): string[] {
    const key = trim(p);
    if (this.lists.has(key)) return this.lists.get(key)!;
    const out: string[] = [];
    const visit = (rel: string) => {
      const abs = join(this.root, rel);
      if (!statSync(abs).isDirectory()) { out.push(rel); return; }
      for (const n of readdirSync(abs)) if (!SKIP.has(n)) visit(rel ? `${rel}/${n}` : n);
    };
    if (this.exists(key)) visit(key);
    this.lists.set(key, out);
    return out;
  }

  lines(file: string): string[] {
    if (!this.text.has(file)) {
      let t = "";
      try { t = readFileSync(join(this.root, file), "utf8"); } catch { /* unreadable */ }
      this.text.set(file, t.split("\n"));
    }
    return this.text.get(file)!;
  }

  find(p: string, re: RegExp): { file: string; line: number }[] {
    const out = [];
    for (const f of this.files(p)) {
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|prisma|sql|py|go|rb|java|kt|cs|rs|php|graphql|proto)$/.test(f)) continue;
      const ls = this.lines(f);
      for (let i = 0; i < ls.length; i++) if (re.test(ls[i])) out.push({ file: f, line: i + 1 });
    }
    return out;
  }

  anyPathOrLine(p: string, re: RegExp): boolean {
    return this.files(p).some((f) => re.test(f)) || this.find(p, re).length > 0;
  }

  imports(file: string): { spec: string; line: number }[] {
    const out: { spec: string; line: number }[] = [];
    const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
    this.lines(file).forEach((l, i) => { for (const m of l.matchAll(re)) out.push({ spec: m[1], line: i + 1 }); });
    return out;
  }

  // A specifier as a repository path: relative, or into a workspace package.
  resolveImport(from: string, spec: string): string | null {
    let base: string | null = null;
    if (spec.startsWith(".")) base = relative(this.root, resolve(this.root, dirname(from), spec));
    else {
      const pkgs = this.workspacePackages();
      const name = [...pkgs.keys()].filter((n) => spec === n || spec.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0];
      if (!name) return null;
      base = join(pkgs.get(name)!, spec.slice(name.length));
    }
    for (const cand of [base, ...["ts", "tsx", "js", "jsx", "mjs"].flatMap((e) => [`${base}.${e}`, `${base}/index.${e}`])]) {
      if (this.exists(cand) && !this.isDir(cand)) return cand;
    }
    return this.exists(base) ? trim(base) : null;
  }

  workspacePackages(): Map<string, string> {
    if (this.packages) return this.packages;
    this.packages = new Map();
    const visit = (rel: string, depth: number) => {
      const abs = join(this.root, rel);
      if (existsSync(join(abs, "package.json"))) {
        try {
          const name = JSON.parse(readFileSync(join(abs, "package.json"), "utf8")).name;
          if (name && rel) this.packages!.set(name, rel);
        } catch { /* not json */ }
      }
      if (depth >= 3) return;
      for (const n of readdirSync(abs)) {
        if (SKIP.has(n) || n.startsWith(".")) continue;
        if (statSync(join(abs, n)).isDirectory()) visit(rel ? `${rel}/${n}` : n, depth + 1);
      }
    };
    visit("", 0);
    return this.packages;
  }

  // Prisma models with their fields and the field lists their indexes cover.
  prismaModels(): Map<string, { fields: Set<string>; indexes: Set<string> }> {
    const out = new Map<string, { fields: Set<string>; indexes: Set<string> }>();
    const schemas = this.files("").filter((f) => f.endsWith(".prisma"));
    for (const f of schemas) {
      let cur: { fields: Set<string>; indexes: Set<string> } | null = null;
      for (const raw of this.lines(f)) {
        const l = raw.trim();
        const head = l.match(/^model\s+(\w+)\s*\{/);
        if (head) { cur = { fields: new Set(), indexes: new Set() }; out.set(head[1], cur); continue; }
        if (!cur) continue;
        if (l === "}") { cur = null; continue; }
        const block = l.match(/^@@(?:index|unique|id)\(\s*(?:fields:\s*)?\[([^\]]+)\]/);
        if (block) { cur.indexes.add(block[1].split(",").map((x) => x.trim().replace(/\(.*\)$/, "")).join(",")); continue; }
        const field = l.match(/^(\w+)\s+\w/);
        if (field && !l.startsWith("//")) {
          cur.fields.add(field[1]);
          if (/@unique\b|@id\b/.test(l)) cur.indexes.add(field[1]);
        }
      }
    }
    return out;
  }
}
