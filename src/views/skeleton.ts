// Code view: a TypeScript skeleton whose file layout mirrors the plan.
//
//   <module>/<Contract>.contract.ts  public: DTOs, the Api interface, events
//   <module>/schema.ts               private: stored entity shapes
//   <module>/repositories.ts         private: access patterns as interfaces
//   <module>/index.ts                wiring: deps in, Api + event handlers out
//   <module>/<store>.sql             relational stores: tables and indexes
//   <module>/<store>.keys.ts         key-value stores: key builders per item type
//   <module>/routes.ts               endpoints bound to the operations they call
//   <module>/ports.ts                interfaces for what is injected from outside the domain
//   <module>/telemetry.ts            the signals the module emits, and a typed emit
//   <module>/<module>.test.ts        planned tests as todos
//
// Other modules may import only `*.contract.ts`. Because every cross-module
// import is a `import type * as X from "../x/X.contract.ts"`, the boundary is
// visible in the code and checkable with a lint rule.

import type { Contract, Entity, Field, Module, Plan, RepoMethod, Store, TypeExpr } from "../ast.ts";
import { posix } from "node:path";
import { indexPlan } from "../check.ts";
import { indexName, RELATIONAL, sqlType, templateFields } from "../storage.ts";
import { walk } from "../walk.ts";

export type Files = Map<string, string>;

const KERNEL = `// Generated. Shared primitives every module may use.
export type Uuid = string & { readonly __brand?: "Uuid" };
export type Decimal = string & { readonly __brand?: "Decimal" };

export type Result<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type Publish<Events> = <K extends keyof Events>(name: K, payload: Events[K]) => Promise<void>;
`;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2023", module: "nodenext", strict: true, noEmit: true,
    allowImportingTsExtensions: true, verbatimModuleSyntax: true, types: ["node"],
  },
  include: ["**/*.ts"],
}, null, 2) + "\n";

export function skeleton(plan: Plan): Files {
  const files: Files = new Map([["kernel.ts", KERNEL], ["tsconfig.json", TSCONFIG]]);
  const ix = indexPlan(plan);
  // Sub-modules get folders inside their parent's: payments/gateway/.
  dirs = new Map(walk(plan).map((p) => [p.module, p.path.toLowerCase()]));
  for (const { module: m } of walk(plan)) {
    const dir = dirOf(m);
    const scope = new Scope(m, ix.contractOwner);
    for (const c of m.provides) files.set(`${dir}/${c.name}.contract.ts`, contractFile(c, scope));
    if (m.entities.length) {
      files.set(`${dir}/schema.ts`, schemaFile(m, scope));
      files.set(`${dir}/repositories.ts`, repositoriesFile(m));
    }
    files.set(`${dir}/index.ts`, indexFile(m, scope));
    for (const st of m.stores) {
      const slug = st.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (RELATIONAL.has(st.engine)) files.set(`${dir}/${slug}.sql`, sqlFile(m, st));
      else files.set(`${dir}/${slug}.keys.ts`, keysFile(m, st));
    }
    if (m.endpoints.length) files.set(`${dir}/routes.ts`, routesFile(m, ix.contractOwner));
    if (m.ports?.length) files.set(`${dir}/ports.ts`, portsFile(m));
    if (m.signals?.length) files.set(`${dir}/telemetry.ts`, telemetryFile(m));
    const planned = m.tests.filter((x) => !x.exists);
    if (planned.length) files.set(`${dir}/${m.name.toLowerCase()}.test.ts`, testsFile(m, planned));
  }
  return files;
}

// DDL for a relational store. Columns follow the entity unless the binding
// overrides them; enums referenced by a column become database enums.
function sqlFile(m: Module, st: Store): string {
  const enumDefs = new Map(m.provides.flatMap((c) => c.types.filter((t) => t.kind === "enum").map((t) => [t.name, t.values] as const)));
  const enums = new Set(enumDefs.keys());
  const used = new Set<string>();
  const tables = st.holds.map((b) => {
    const e = m.entities.find((x) => x.name === b.entity)!;
    const cols = e.fields.map((f) => {
      const o = b.columns?.find((c) => c.field === f.name);
      const d = sqlType(f.type, enums);
      const bare = f.type.kind === "optional" ? f.type.of : f.type;
      if (bare.kind === "ref" && enums.has(bare.name)) used.add(bare.name);
      const nullable = o?.nullable ?? d.nullable;
      return `  "${o?.column ?? f.name}" ${o?.type ?? d.type}${nullable ? "" : " NOT NULL"}${o?.default ? ` DEFAULT ${o.default}` : ""}`;
    });
    cols.push(`  PRIMARY KEY (${e.key.map((k) => `"${k}"`).join(", ")})`);
    const idx = b.indexes.map((i) =>
      `CREATE ${i.unique ? "UNIQUE " : ""}INDEX "${indexName(b, i)}" ON "${b.table}"${i.using ? ` USING ${i.using}` : ""} (${i.on.map((c) => `"${c}"`).join(", ")})${i.where ? ` WHERE ${i.where}` : ""};`);
    return [`CREATE TABLE "${b.table}" (\n${cols.join(",\n")}\n);`, ...idx].join("\n");
  });
  const types = [...used].map((n) => `CREATE TYPE "${n}" AS ENUM (${enumDefs.get(n)!.map((v) => `'${v}'`).join(", ")});`);
  return [`-- Generated from the plan: ${m.name} / ${st.name} (${st.engine}).`, ...types, ...tables].join("\n\n") + "\n";
}

// Key builders for a key-value store, one per item type, so every read and
// write spells its keys the same way.
function keysFile(m: Module, st: Store): string {
  const out = [`// Generated from the plan: ${m.name} / ${st.name} (${st.engine}).`, ""];
  const fn = (tpl: string) => {
    const fs = templateFields(tpl);
    return `(k: { ${fs.map((f) => `${f}: string`).join("; ")} }) => \`${tpl.replace(/\{(\w+)\}/g, "${k.$1}")}\``;
  };
  for (const b of st.holds) {
    out.push(`/** ${b.entity} items in "${b.table}". */`);
    out.push(`export const ${lowerFirst(b.entity)}Keys = {`);
    out.push(`  table: ${JSON.stringify(b.table)},`);
    if (b.pk) out.push(`  pk: ${fn(b.pk)},`);
    if (b.sk) out.push(`  sk: ${fn(b.sk)},`);
    for (const g of b.gsis) {
      out.push(`  ${g.name}: { index: ${JSON.stringify(g.name)}, pk: ${fn(g.pk)}${g.sk ? `, sk: ${fn(g.sk)}` : ""} },`);
    }
    if (b.ttl) out.push(`  ttl: ${JSON.stringify(b.ttl)},`);
    out.push("} as const;", "");
  }
  return out.join("\n");
}

// Each endpoint bound to the operations it calls. The compiler checks the
// binding against the contract, so a renamed operation breaks the route here.
function routesFile(m: Module, owners: Map<string, Module>): string {
  const dir = dirOf(m);
  const contracts = [...new Set(m.endpoints.flatMap((e) => e.calls.map((c) => c.split(".")[0])))];
  const imports = contracts.map((c) => `import type * as ${c} from "${rel(dir, dirOf(owners.get(c)!), `${c}.contract.ts`)}";`);
  const api = contracts.map((c) => `${lowerFirst(c)}: ${c}.${c}Api`).join("; ");
  const rows = m.endpoints.map((e) => {
    const calls = e.calls.map((c) => { const [k, o] = c.split("."); return `api.${lowerFirst(k)}.${lowerFirst(o)}`; });
    return `    { ${e.method ? `method: "${e.method}", ` : ""}${e.protocol === "http" ? "" : `protocol: "${e.protocol}", `}path: ${JSON.stringify(e.path)}, auth: ${JSON.stringify(e.auth)}, audience: "${e.audience}", calls: [${calls.join(", ")}] },`;
  });
  return [
    "// Generated from the plan. Endpoints only parse, authorise and call; no logic here.",
    ...imports, "",
    `export function routes(api: { ${api} }) {`,
    "  return [", ...rows, "  ] as const;", "}", "",
  ].join("\n");
}

// One interface per port. Method signatures in a plan are informal, so they
// become comments; the names are real.
function portsFile(m: Module): string {
  const body = m.ports.map((p) => {
    const ad = p.adapters.map((a) => `${a.env} ${a.name}`).join(", ");
    const doc = [p.purpose, ad && `Adapters: ${ad}.`, !p.injected && "Today the code imports this directly."].filter(Boolean).join(" ");
    const meths = p.methods.map((x) => `  /** ${x} */\n  ${x.split("(")[0].trim()}(...args: unknown[]): Promise<unknown>;`);
    return `/** ${doc} */\nexport interface ${p.name} {\n${meths.join("\n")}\n}`;
  });
  return header([], body);
}

// The module's signals as data, and an emit function typed by them, so a
// signal with a missing or extra field does not compile.
function telemetryFile(m: Module): string {
  const rows = m.signals.map((x) =>
    `  ${JSON.stringify(x.name)}: { type: "${x.type}", on: ${JSON.stringify(x.on)}, fields: [${x.fields.map((f) => JSON.stringify(f)).join(", ")}]${x.alert ? `, alert: ${JSON.stringify(x.alert)}` : ""} },`);
  return header([], [
    `export const signals = {\n${rows.join("\n")}\n} as const;`,
    "type Signals = typeof signals;",
    "export type Emit = <K extends keyof Signals>(name: K, fields: Record<Signals[K][\"fields\"][number], unknown>) => void;",
  ]);
}

// Planned tests, as todos the test runner lists until someone writes them.
function testsFile(m: Module, tests: Module["tests"]): string {
  const body = tests.map((x) => {
    const how = [x.level, `covers ${x.covers.join(", ")}`, x.fakes.length && `fakes ${x.fakes.join(", ")}`].filter(Boolean).join("; ");
    return `test(${JSON.stringify(x.name)}, { todo: ${JSON.stringify(how)} }, () => {});`;
  });
  return header([`import { test } from "node:test";`], [body.join("\n")], "Generated once from the plan: the tests it calls for.");
}

let dirs = new Map<Module, string>();
const dirOf = (m: Module) => dirs.get(m) ?? m.name.toLowerCase();
// An import specifier from one module folder to a file in another.
const rel = (fromDir: string, toDir: string, file: string) => {
  const r = posix.relative(fromDir, toDir);
  return `${r ? (r.startsWith(".") ? r : `./${r}`) : "."}/${file}`;
};
const kernelFrom = (dir: string) => rel(dir, "", "kernel.ts");
const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s[0].toUpperCase() + s.slice(1);

// Knows how to spell a type reference from inside one file, and which
// imports that spelling needs.
class Scope {
  module: Module;
  owners: Map<string, Module>;
  needed = new Set<string>();     // contract names referenced from this file
  constructor(module: Module, owners: Map<string, Module>) {
    this.module = module;
    this.owners = owners;
  }

  fork(): Scope { return new Scope(this.module, this.owners); }

  ts(t: TypeExpr, local: Contract | null): string {
    switch (t.kind) {
      case "prim": return PRIM[t.name];
      case "list": return `${this.ts(t.of, local)}[]`;
      case "optional": return `${this.ts(t.of, local)} | null`;
      case "ref": {
        if (t.name.includes(".")) { this.needed.add(t.name.split(".")[0]); return t.name; }
        if (local?.types.some((d) => d.name === t.name)) return t.name;
        if (this.module.entities.some((e) => e.name === t.name)) return t.name;
        const own = this.module.provides.find((c) => c.types.some((d) => d.name === t.name));
        if (own) { this.needed.add(own.name); return `${own.name}.${t.name}`; }
        return t.name;
      }
    }
  }

  imports(fromDir: string, exclude: string | null = null): string[] {
    const lines = [];
    for (const c of [...this.needed].sort()) {
      if (c === exclude) continue;
      const owner = this.owners.get(c)!;
      const path = rel(fromDir, dirOf(owner), `${c}.contract.ts`);
      lines.push(`import type * as ${c} from "${path}";`);
    }
    return lines;
  }
}

const PRIM: Record<string, string> = {
  string: "string", int: "number", decimal: "Decimal", boolean: "boolean", datetime: "Date", uuid: "Uuid",
};

function fieldsTs(fs: Field[], s: Scope, local: Contract | null, indent = "  "): string {
  return fs.map((f) => `${indent}${f.name}: ${s.ts(f.type, local)};`).join("\n");
}

function contractFile(c: Contract, parent: Scope): string {
  const s = parent.fork();
  const body: string[] = [];
  for (const t of c.types) {
    body.push(t.kind === "enum"
      ? `export type ${t.name} = ${t.values.map((v) => JSON.stringify(v)).join(" | ")};`
      : `export type ${t.name} = {\n${fieldsTs(t.fields, s, c)}\n};`);
  }
  const api = [`export interface ${c.name}Api {`];
  for (const o of c.operations) {
    const input = o.input.length ? `input: {\n${fieldsTs(o.input, s, c, "    ")}\n  }` : "";
    const out = o.output ? s.ts(o.output, c) : "void";
    const ret = o.errors.length ? `Result<${out}, ${o.errors.map((e) => JSON.stringify(e)).join(" | ")}>` : out;
    api.push(`  /** ${o.mode} */`, `  ${lowerFirst(o.name)}(${input}): Promise<${ret}>;`);
  }
  body.push([...api, "}"].join("\n"));
  const events = c.events.map((e) => `  ${e.name}: {\n${fieldsTs(e.payload, s, c, "    ")}\n  };`);
  body.push([`export type ${c.name}Events = {`, ...events, "};"].join("\n"));
  return header([`import type { Decimal, Result, Uuid } from "${kernelFrom(dirOf(parent.module))}";`, ...s.imports(dirOf(parent.module), c.name)], body);
}

function schemaFile(m: Module, parent: Scope): string {
  const s = parent.fork();
  const body = m.entities.map((e: Entity) => {
    const doc = e.doc ? `/** ${e.doc} */\n` : "";
    return `${doc}export type ${e.name} = {\n${fieldsTs(e.fields, s, null)}\n};\nexport type ${e.name}Key = Pick<${e.name}, ${e.key.map((k) => JSON.stringify(k)).join(" | ")}>;`;
  });
  // An aggregate is loaded and saved whole, through its root.
  for (const a of m.aggregates) {
    const members = a.members.map((x) => `  ${lowerFirst(x)}s: ${x}[];`);
    const inv = a.invariants.length ? `/**\n * Invariants:\n${a.invariants.map((i) => ` * - ${i}`).join("\n")}\n */\n` : "";
    body.push(`${inv}export type ${a.name}Aggregate = {\n  root: ${a.root};\n${members.join("\n")}\n};`);
  }
  return header([`import type { Decimal, Uuid } from "${kernelFrom(dirOf(m))}";`, ...s.imports(dirOf(m))], body);
}

function repositoriesFile(m: Module): string {
  const body = m.repositories.map((r) => {
    const agg = m.aggregates.find((a) => a.root === r.entity);
    const sigs = r.methods.map((meth) => `  ${repoSig(r.entity, meth, agg ? `${agg.name}Aggregate` : r.entity)};`);
    return `export interface ${r.name} {\n${sigs.join("\n")}\n}`;
  });
  const names = [...m.entities.flatMap((e) => [e.name, `${e.name}Key`]), ...m.aggregates.map((a) => `${a.name}Aggregate`)]
    .filter((n) => new RegExp(`\\b${n}\\b`).test(body.join("\n"))).join(", ");
  return header([`import type { ${names} } from "./schema.ts";`], body);
}

// `whole` is what the repository hands back: the entity, or for an aggregate
// root, the whole aggregate.
function repoSig(e: string, meth: RepoMethod, whole: string): string {
  switch (meth.kind) {
    case "get": return `get(key: ${e}Key): Promise<${whole} | null>`;
    case "find": {
      const member = meth.by[0].includes(".") ? meth.by[0].split(".")[0] : e;
      const cols = meth.by.map((f) => f.split(".").pop()!);
      const name = meth.by.map((f) => f.split(".").map(upperFirst).join("")).join("And");
      return `findBy${name}(by: Pick<${member}, ${cols.map((f) => JSON.stringify(f)).join(" | ")}>): Promise<${whole}[]>`;
    }
    case "save": return `save(${whole === e ? "entity" : "aggregate"}: ${whole}): Promise<void>`;
    case "delete": return `delete(key: ${e}Key): Promise<void>`;
  }
}

function indexFile(m: Module, parent: Scope): string {
  const s = parent.fork();
  const body: string[] = [];
  const depLines: string[] = [];
  for (const u of m.uses) { s.needed.add(u.contract); depLines.push(`  ${lowerFirst(u.contract)}: ${u.contract}.${u.contract}Api;`); }
  for (const r of m.repositories) depLines.push(`  ${lowerFirst(r.name)}: ${r.name};`);
  const ports = m.ports.filter((p) => p.injected);
  for (const p of ports) depLines.push(`  ${lowerFirst(p.name)}: ${p.name};`);
  if (m.signals?.length) depLines.push("  emit: Emit;");
  for (const c of m.provides) {
    s.needed.add(c.name);
    if (c.events.length) depLines.push(`  publish${c.name}: Publish<${c.name}.${c.name}Events>;`);
  }
  body.push(`export type ${m.name}Deps = {\n${depLines.join("\n")}\n};`);

  const outLines: string[] = [];
  for (const c of m.provides) outLines.push(`  ${lowerFirst(c.name)}: ${c.name}.${c.name}Api;`);
  const handlers = m.uses.filter((u) => u.subscribes.length);
  if (handlers.length) {
    outLines.push("  on: {");
    for (const u of handlers) {
      for (const ev of u.subscribes) {
        outLines.push(`    ${u.contract}${ev}(event: ${u.contract}.${u.contract}Events["${ev}"]): Promise<void>;`);
      }
    }
    outLines.push("  };");
  }
  body.push(`export type ${m.name}Module = {\n${outLines.join("\n")}\n};`);

  const impl: string[] = [];
  for (const c of m.provides) {
    impl.push(`    ${lowerFirst(c.name)}: {`);
    for (const o of c.operations) impl.push(`      async ${lowerFirst(o.name)}() { throw todo("${c.name}.${o.name}"); },`);
    impl.push("    },");
  }
  if (handlers.length) {
    impl.push("    on: {");
    for (const u of handlers) for (const ev of u.subscribes) impl.push(`      async ${u.contract}${ev}() { throw todo("on ${u.contract}.${ev}"); },`);
    impl.push("    },");
  }
  body.push(
    `export function create${m.name}(deps: ${m.name}Deps): ${m.name}Module {\n  void deps;\n  return {\n${impl.join("\n")}\n  };\n}`,
    `const todo = (what: string) => new Error(\`not implemented: \${what}\`);`,
  );

  const kernel = m.provides.some((c) => c.events.length) ? [`import type { Publish } from "${kernelFrom(dirOf(m))}";`] : [];
  const repos = m.repositories.length ? [`import type { ${m.repositories.map((r) => r.name).join(", ")} } from "./repositories.ts";`] : [];
  if (ports.length) repos.push(`import type { ${ports.map((p) => p.name).join(", ")} } from "./ports.ts";`);
  if (m.signals?.length) repos.push(`import type { Emit } from "./telemetry.ts";`);
  return header([...kernel, ...s.imports(dirOf(m)), ...repos], body,
    "Generated once from the plan as a starting point. Implement the module here.");
}

function header(imports: string[], body: string[], note = "Generated from the plan. Edit the plan, not this file."): string {
  return [`// ${note}`, ...imports, "", body.join("\n\n"), ""].join("\n");
}
