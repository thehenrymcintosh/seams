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

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Located, Module, Plan } from "./ast.ts";
import { indexPlan } from "./check.ts";
import { walk } from "./walk.ts";

export type Finding = { level: "error" | "warning"; at: string; message: string };

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", "out"]);
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro|prisma|sql|py|go|rb|java|kt|cs|rs|php|graphql|proto)$/;

// `baseline` is the tree the change starts from. Operations and endpoints that
// are new against it must point at their code with src(); a name match is
// not enough to say a new thing was built.
export function verify(plan: Plan, root: string | Files, baseline?: Plan): Finding[] {
  const out: Finding[] = [];
  const err = (at: string, message: string) => out.push({ level: "error", at, message });
  const warn = (at: string, message: string) => out.push({ level: "warning", at, message });
  const repo = new Repo(typeof root === "string" ? diskFiles(root) : root);
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
    for (const x of m.ports) located.push([`${path} / port ${x.name}`, x]);
    for (const x of m.signals) located.push([`${path} / ${x.type} ${x.name}`, x]);
    for (const x of m.tests) {
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
      if (s.line && !hits.some((h) => h.file === clean(s.path) && Math.abs(h.line - s.line!) <= 15)) {
        const h = hits[0];
        warn(at, `${where}: expected near line ${s.line}, found at ${h.file}:${h.line}`);
      }
    }
  }

  // --- imports: who owns each file is decided by the most specific module source
  const owners: { dir: string; module: Module; path: string }[] = [];
  for (const { module: m, path } of tree) {
    // A folder owns everything under it; a file owns itself.
    for (const s of m.sources ?? []) if (repo.exists(s.path)) owners.push({ dir: clean(s.path), module: m, path });
  }
  owners.sort((a, b) => b.dir.length - a.dir.length);
  const ownerOf = (file: string) => owners.find((o) => file === o.dir || o.dir === "" || file.startsWith(`${o.dir}/`));
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
        const reached = [t.module, ...(tree.find((p) => p.module === t.module)?.ancestors ?? [])].map((x) => x.name);
        const gap = o.module.gaps.find((g) => reached.includes(g.module));
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
    for (const g of m.gaps) {
      if (!ix.moduleByName.has(g.module)) err(`${path} / gap ${g.module}`, `no module named ${g.module}`);
      else if (!gapsSeen.has(g) && m.depth === "mapped" && owners.some((o) => o.module === m)) warn(`${path} / gap ${g.module}`, `the code no longer imports ${g.module}; remove the gap`);
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
          if (!model) { err(at, `no model or @@map named ${b.table} in schema.prisma`); continue; }
          const e = m.entities.find((x) => x.name === b.entity);
          for (const f of e?.fields ?? []) {
            const col = b.columns?.find((c) => c.field === f.name)?.column ?? f.name;
            if (!model.has(col)) err(at, `column ${col} is not in model ${b.table}`);
          }
          for (const i of b.indexes) {
            if (!model.index(i.on)) err(at, `no index on (${i.on.join(", ")}) in model ${b.table}`);
          }
        }
      }
    }
  }

  // --- operations: the code has something named after each one
  for (const { module: m, path } of tree) {
    for (const c of m.provides) {
      const dirs = [...(c.sources ?? []), ...(m.sources ?? [])].map((s) => s.path).filter((p) => repo.exists(p));
      for (const o of c.operations) {
        if (o.sources?.length) continue;
        if (before && !oldOps.has(`${c.name}.${o.name}`)) {
          err(`${path} / ${c.name}.${o.name}`, "is new in this change; give it a src() pointing at the code that implements it");
          continue;
        }
        if (m.depth !== "mapped" || !dirs.length) continue;
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
// A path as the repo walk spells it: forward slashes, no "./", no trailing "/".
export const clean = (p: string) => {
  const n = posix.normalize(p.replace(/\\/g, "/"));
  return n === "." || n === "./" ? "" : trim(n.replace(/^\.\//, ""));
};

// The text with everything that can't be an import blanked out: comments,
// template literals, regex literals, and strings that don't follow `from`,
// `import` or `require(`. Line breaks stay, so line numbers still match.
export function codeOnly(text: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "str" | "tpl" | "re" = "code";
  let quote = "", keep = false, inClass = false;
  // A `/` starts a regex, not a division, after an operator, an opening
  // bracket, or a keyword that takes an expression.
  const regexMayStart = () => {
    const before = out.trimEnd();
    return before === "" || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(?:return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(before);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    const blank = c === "\n" ? "\n" : " ";
    if (mode === "code") {
      if (c === "/" && next === "/") { mode = "line"; out += "  "; i++; continue; }
      if (c === "/" && next === "*") { mode = "block"; out += "  "; i++; continue; }
      if (c === "/" && regexMayStart()) { mode = "re"; inClass = false; out += " "; continue; }
      if (c === "`") { mode = "tpl"; out += " "; continue; }
      if (c === "'" || c === '"') {
        mode = "str"; quote = c;
        keep = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*$/.test(out);
      }
      out += c;
    } else if (mode === "line") {
      if (c === "\n") mode = "code";
      out += blank;
    } else if (mode === "block") {
      if (c === "*" && next === "/") { mode = "code"; out += "  "; i++; continue; }
      out += blank;
    } else if (mode === "tpl") {
      if (c === "\\") { out += next === "\n" ? " \n" : "  "; i++; continue; }
      if (c === "`") mode = "code";
      out += blank;
    } else if (mode === "re") {
      if (c === "\\" && next !== "\n") { out += "  "; i++; continue; }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if ((c === "/" && !inClass) || c === "\n") mode = "code";
      out += blank;
    } else {
      if (c === "\\" && next !== "\n") { out += keep ? c + next : "  "; i++; continue; }
      if (c === quote || c === "\n") { mode = "code"; out += c; continue; }
      out += keep ? c : " ";
    }
  }
  return out;
}
// A symbol as a whole word. Symbols can start or end with punctuation
// (a quoted command name), where \b would never match.
const wordRe = (s: string) => {
  const body = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${/^\w/.test(s) ? "(?<![\\w$])" : ""}${body}${/\w$/.test(s) ? "(?![\\w$])" : ""}`);
};

// The repository, as paths relative to its root. Verify reads it only through
// this, so a test can hand it an in-memory folder.
// tsconfig.json allows comments and trailing commas. Strip both, leaving
// strings alone (a path pattern like "src/*" looks like a comment opener).
export function jsonc(text: string): string {
  return text
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "")
    .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, close) => str ?? close);
}

export type Files = {
  exists(p: string): boolean;
  isDir(p: string): boolean;
  list(dir: string): string[];          // entry names in a folder
  read(file: string): string;
};

export function diskFiles(root: string): Files {
  const abs = (p: string) => join(root, p);
  return {
    exists: (p) => existsSync(abs(p)),
    // lstat: a symlinked folder is not followed, so a link loop can't hang the walk.
    isDir: (p) => existsSync(abs(p)) && lstatSync(abs(p)).isDirectory(),
    list: (d) => readdirSync(abs(d)),
    read: (f) => readFileSync(abs(f), "utf8"),
  };
}

// { "src/a.ts": "...", "prisma/schema.prisma": "..." } as a folder.
export function memoryFiles(files: Record<string, string>): Files {
  const paths = Object.keys(files);
  const isDir = (p: string) => p === "" || paths.some((f) => f.startsWith(`${trim(p)}/`));
  return {
    exists: (p) => p in files || isDir(p),
    isDir,
    list: (d) => [...new Set(paths.filter((f) => d === "" || f.startsWith(`${trim(d)}/`))
      .map((f) => (d === "" ? f : f.slice(trim(d).length + 1)).split("/")[0]))],
    read: (f) => files[f] ?? "",
  };
}

// The repository, read lazily and cached: file lists, contents, packages.
class Repo {
  fs: Files;
  private text = new Map<string, string[]>();
  private lists = new Map<string, string[]>();
  private packages: Map<string, string> | null = null;
  constructor(fs: Files) { this.fs = fs; }

  exists(p: string) { return this.fs.exists(clean(p)); }
  isDir(p: string) { return this.fs.isDir(clean(p)); }

  files(p: string): string[] {
    const key = clean(p);
    if (this.lists.has(key)) return this.lists.get(key)!;
    const out: string[] = [];
    const visit = (rel: string) => {
      if (!this.fs.isDir(rel)) { out.push(rel); return; }
      for (const n of this.fs.list(rel)) if (!SKIP.has(n)) visit(rel ? `${rel}/${n}` : n);
    };
    if (this.exists(key)) visit(key);
    this.lists.set(key, out);
    return out;
  }

  lines(file: string): string[] {
    if (!this.text.has(file)) {
      let t = "";
      try { t = this.fs.read(file); } catch { /* unreadable */ }
      this.text.set(file, t.split("\n"));
    }
    return this.text.get(file)!;
  }

  // Lines matching `re` in a file, or in the source files under a folder.
  find(p: string, re: RegExp): { file: string; line: number }[] {
    const out = [];
    const single = !this.isDir(p);
    for (const f of this.files(p)) {
      if (!single && !SOURCE.test(f)) continue;
      const ls = this.lines(f);
      for (let i = 0; i < ls.length; i++) if (re.test(ls[i])) out.push({ file: f, line: i + 1 });
    }
    return out;
  }

  anyPathOrLine(p: string, re: RegExp): boolean {
    return this.files(p).some((f) => re.test(f)) || this.find(p, re).length > 0;
  }

  // Import specifiers, read from the code with comments and template
  // literals blanked out, so an import written inside a string or a comment
  // (a code generator's output, an example) is not mistaken for a real one.
  imports(file: string): { spec: string; line: number }[] {
    const out: { spec: string; line: number }[] = [];
    const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
    codeOnly(this.lines(file).join("\n")).split("\n").forEach((l, i) => {
      for (const m of l.matchAll(re)) out.push({ spec: m[1], line: i + 1 });
    });
    return out;
  }

  // A specifier as a repository path: relative, a tsconfig path alias, or
  // into a workspace package (its source folder, main or exports entry).
  resolveImport(from: string, spec: string): string | null {
    if (spec.startsWith(".")) return this.firstFile([posix.normalize(posix.join(posix.dirname(from), spec))]);
    const alias = this.aliases().flatMap(([prefix, targets]) =>
      spec === prefix || (prefix.endsWith("/") && spec.startsWith(prefix)) ? targets.map((t) => t + spec.slice(prefix.length)) : []);
    if (alias.length) return this.firstFile(alias);
    const pkgs = this.workspacePackages();
    const name = [...pkgs.keys()].filter((n) => spec === n || spec.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0];
    if (!name) return null;
    const dir = pkgs.get(name)!, rest = spec.slice(name.length).replace(/^\//, "");
    if (rest) return this.firstFile([posix.join(dir, rest), posix.join(dir, "src", rest)]);
    const entry = this.packageEntry(dir);
    return this.firstFile([...(entry ? [posix.join(dir, entry)] : []), posix.join(dir, "src/index"), posix.join(dir, "index")]) ?? dir;
  }

  // The first candidate that is a file, trying TypeScript for a `.js`
  // specifier (NodeNext style), then extensions and index files.
  private firstFile(bases: string[]): string | null {
    for (const raw of bases) {
      const base = clean(raw);
      const stem = base.replace(/\.(m|c)?jsx?$/, "");
      const cands = [base, ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].flatMap((e) => [`${stem}.${e}`, `${base}/index.${e}`])];
      for (const c of cands) if (this.exists(c) && !this.isDir(c)) return c;
    }
    for (const raw of bases) if (this.exists(raw)) return clean(raw);
    return null;
  }

  private packageEntry(dir: string): string | null {
    try {
      const pkg = JSON.parse(this.fs.read(`${dir}/package.json`));
      const dot = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
      const fromExports = typeof dot === "string" ? dot : dot?.import ?? dot?.default ?? dot?.types;
      return pkg.source ?? (typeof fromExports === "string" ? fromExports : null) ?? pkg.module ?? pkg.main ?? null;
    } catch { return null; }
  }

  // compilerOptions.paths from the root tsconfig.json, as [prefix, target folders].
  private aliasCache: [string, string[]][] | null = null;
  aliases(): [string, string[]][] {
    if (this.aliasCache) return this.aliasCache;
    this.aliasCache = [];
    try {
      const raw = jsonc(this.fs.read("tsconfig.json"));
      const { baseUrl = ".", paths = {} } = JSON.parse(raw).compilerOptions ?? {};
      for (const [pattern, targets] of Object.entries(paths as Record<string, string[]>)) {
        this.aliasCache.push([pattern.replace(/\*$/, ""), targets.map((t) => posix.join(baseUrl, t.replace(/\*$/, "")) + (t.endsWith("/*") ? "/" : ""))]);
      }
    } catch { /* no tsconfig, or not JSON */ }
    return this.aliasCache;
  }

  workspacePackages(): Map<string, string> {
    if (this.packages) return this.packages;
    this.packages = new Map();
    const visit = (rel: string, depth: number) => {
      const manifest = rel ? `${rel}/package.json` : "package.json";
      if (rel && this.fs.exists(manifest)) {
        try {
          const name = JSON.parse(this.fs.read(manifest)).name;
          if (name) this.packages!.set(name, rel);
        } catch { /* not json */ }
      }
      if (depth >= 3) return;
      for (const n of this.fs.list(rel)) {
        const child = rel ? `${rel}/${n}` : n;
        if (!SKIP.has(n) && !n.startsWith(".") && this.fs.isDir(child)) visit(child, depth + 1);
      }
    };
    visit("", 0);
    return this.packages;
  }

  // Prisma models, found by model name or by their @@map table name. Fields
  // are known by Prisma name and by @map column name; index field lists are
  // kept in Prisma names, and `index()` accepts either spelling.
  prismaModels(): Map<string, PrismaModel> {
    const out = new Map<string, PrismaModel>();
    const schemas = this.files("").filter((f) => f.endsWith(".prisma"));
    for (const f of schemas) {
      let cur: PrismaModel | null = null;
      let name = "";
      for (const raw of this.lines(f)) {
        const l = raw.replace(/\/\/.*$/, "").trim();
        const head = l.match(/^model\s+(\w+)\s*\{/);
        if (head) { name = head[1]; cur = new PrismaModel(); out.set(name, cur); continue; }
        if (!cur) continue;
        if (l === "}") { cur = null; continue; }
        const table = l.match(/^@@map\(\s*(?:name:\s*)?"([^"]+)"/);
        if (table) { out.set(table[1], cur); continue; }
        const block = l.match(/^@@(?:index|unique|id)\(\s*(?:fields:\s*)?\[([^\]]+)\]/);
        if (block) { cur.indexes.add(block[1].split(",").map((x) => x.trim().replace(/\(.*\)$/, "")).join(",")); continue; }
        const field = l.match(/^(\w+)\s+\w/);
        if (field) {
          const column = l.match(/@map\(\s*(?:name:\s*)?"([^"]+)"/)?.[1] ?? field[1];
          cur.columns.set(field[1], column);
          if (/@unique\b|@id\b/.test(l)) cur.indexes.add(field[1]);
        }
      }
    }
    return out;
  }
}

class PrismaModel {
  columns = new Map<string, string>();     // Prisma field -> database column
  indexes = new Set<string>();             // "a,b" in Prisma field names
  has(name: string) { return this.columns.has(name) || [...this.columns.values()].includes(name); }
  private field(name: string) { return this.columns.has(name) ? name : [...this.columns].find(([, c]) => c === name)?.[0] ?? name; }
  index(on: string[]) { return this.indexes.has(on.map((x) => this.field(x)).join(",")); }
}
