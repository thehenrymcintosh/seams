// A thin authoring layer over the AST. Plans stay plain data; these helpers
// only fill in `kind` tags and defaults so a plan reads like a spec.

import type {
  Aggregate, Binding, Contract, Endpoint, Engine, Entity, EventDef, Field, Index, Module, Operation, PhysicalIndex, Plan,
  Port, Primitive, RepoMethod, Repository, Signal, SourceRef, Store, TestCase, TypeDef, TypeExpr, Use,
} from "./ast.ts";

// Where a node lives in the code: src("packages/lib/server-only/recipient/", "setDocumentRecipients")
export const src = (path: string, symbol?: string, line?: number): SourceRef => ({ path, symbol, line });

const prim = (name: Primitive): TypeExpr => ({ kind: "prim", name });

export const t = {
  string: prim("string"),
  int: prim("int"),
  decimal: prim("decimal"),
  boolean: prim("boolean"),
  datetime: prim("datetime"),
  uuid: prim("uuid"),
  ref: (name: string): TypeExpr => ({ kind: "ref", name }),
  list: (of: TypeExpr): TypeExpr => ({ kind: "list", of }),
  optional: (of: TypeExpr): TypeExpr => ({ kind: "optional", of }),
};

// Fields are written as an object literal: { id: t.uuid, note: t.optional(t.string) }
export const fields = (shape: Record<string, TypeExpr>): Field[] =>
  Object.entries(shape).map(([name, type]) => ({ name, type }));

export const plan = (name: string, modules: Module[]): Plan => ({ kind: "plan", name, modules });

export const module = (
  name: string,
  m: {
    purpose: string;
    entities?: Entity[];
    repositories?: Repository[];
    provides?: Contract[];
    uses?: (string | Use)[];
    aggregates?: Aggregate[];
    modules?: Module[];
    stores?: Store[];
    endpoints?: Endpoint[];
    ports?: Port[];
    signals?: Signal[];
    tests?: TestCase[];
    sources?: SourceRef[];
    note?: string;
  },
): Module => ({
  kind: "module",
  name,
  purpose: m.purpose,
  depth: "mapped",
  sources: m.sources,
  note: m.note,
  entities: m.entities ?? [],
  aggregates: m.aggregates ?? [],
  repositories: m.repositories ?? [],
  provides: m.provides ?? [],
  uses: (m.uses ?? []).map((u) => (typeof u === "string" ? { contract: u, subscribes: [] } : u)),
  stores: m.stores ?? [],
  endpoints: m.endpoints ?? [],
  ports: m.ports ?? [],
  signals: m.signals ?? [],
  tests: m.tests ?? [],
  modules: m.modules ?? [],
});

export const aggregate = (root: string, members: string[], invariants: string[] = [], name = root): Aggregate =>
  ({ kind: "aggregate", name, root, members, invariants });

export const entity = (
  name: string,
  shape: Record<string, TypeExpr>,
  opts: { key?: string[]; indexes?: Index[]; doc?: string; sources?: SourceRef[]; note?: string } = {},
): Entity => ({
  kind: "entity",
  name,
  doc: opts.doc,
  sources: opts.sources,
  note: opts.note,
  fields: fields(shape),
  key: opts.key ?? ["id"],
  indexes: opts.indexes ?? [],
});

export const repo = (entityName: string, methods: RepoMethod[]): Repository => ({
  kind: "repository",
  name: `${entityName}Repository`,
  entity: entityName,
  methods,
});

export const get: RepoMethod = { kind: "get" };
export const save: RepoMethod = { kind: "save" };
export const del: RepoMethod = { kind: "delete" };
export const findBy = (...by: string[]): RepoMethod => ({ kind: "find", by });

export const contract = (
  name: string,
  c: { types?: TypeDef[]; operations?: Operation[]; events?: EventDef[]; sources?: SourceRef[]; note?: string },
): Contract => ({
  kind: "contract",
  name,
  sources: c.sources,
  note: c.note,
  types: c.types ?? [],
  operations: c.operations ?? [],
  events: c.events ?? [],
});

export const record = (name: string, shape: Record<string, TypeExpr>): TypeDef =>
  ({ kind: "record", name, fields: fields(shape) });

export const enumOf = (name: string, values: string[]): TypeDef =>
  ({ kind: "enum", name, values });

const op = (mode: "command" | "query") =>
  (
    name: string,
    input: Record<string, TypeExpr>,
    output: TypeExpr | null,
    errors: string[] = [],
  ): Operation => ({ kind: "operation", name, mode, input: fields(input), output, errors });

export const command = op("command");
export const query = op("query");

export const event = (name: string, payload: Record<string, TypeExpr>): EventDef =>
  ({ kind: "event", name, payload: fields(payload) });

export const subscribe = (contractName: string, ...events: string[]): Use =>
  ({ contract: contractName, subscribes: events });

// A module the agent knows exists but has not mapped. Its contracts may be
// named (so other modules can depend on them) without their contents.
export const stub = (
  name: string, purpose: string, contracts: string[] = [], sources: SourceRef[] = [], uses: (string | Use)[] = [],
): Module => ({
  kind: "module",
  name,
  purpose,
  depth: "stub",
  sources,
  entities: [],
  aggregates: [],
  repositories: [],
  provides: contracts.map((c) => contract(c, {})),
  uses: uses.map((u) => (typeof u === "string" ? { contract: u, subscribes: [] } : u)),
  stores: [],
  endpoints: [],
  ports: [],
  signals: [],
  tests: [],
  modules: [],
});

// ---- storage ----
// store("main", "postgres", [table("Order", "orders", { indexes: [idx("customerId")] })])
export const store = (name: string, engine: Engine, holds: Binding[], o: { sources?: SourceRef[]; note?: string } = {}): Store =>
  ({ kind: "store", name, engine, holds, ...o });

export const table = (entityName: string, tableName: string, o: Omit<Binding, "entity" | "table"> = {}): Binding =>
  ({ entity: entityName, table: tableName, ...o });

export const idx = (...on: string[]): PhysicalIndex => ({ on });
export const uniqueIdx = (...on: string[]): PhysicalIndex => ({ on, unique: true });

// ---- endpoints ----
// http("POST", "/orders", "Orders.PlaceOrder", { auth: "session" })
export const http = (
  method: NonNullable<Endpoint["method"]>, path: string, calls: string | string[],
  o: { auth: string; audience?: Endpoint["audience"]; name?: string; sources?: SourceRef[]; note?: string },
): Endpoint => ({
  kind: "endpoint", protocol: "http", method, path, name: o.name ?? `${method} ${path}`,
  calls: typeof calls === "string" ? [calls] : calls, auth: o.auth, audience: o.audience ?? "public", sources: o.sources, note: o.note,
});

// rpc("trpc", "recipient.rejectDocumentWithToken", "Signing.Reject", { auth: "recipient token" })
export const rpc = (
  protocol: Exclude<Endpoint["protocol"], "http">, path: string, calls: string | string[],
  o: { auth: string; audience?: Endpoint["audience"]; name?: string; sources?: SourceRef[]; note?: string },
): Endpoint => ({
  kind: "endpoint", protocol, path, name: o.name ?? path,
  calls: typeof calls === "string" ? [calls] : calls, auth: o.auth, audience: o.audience ?? "app", sources: o.sources, note: o.note,
});

// ---- wiring ----
// port("Mailer", "Sends transactional email", ["send(to, template, data)"], { prod: "ResendMailer", test: "InMemoryMailer" })
type Located = { sources?: SourceRef[]; note?: string };
type Adapters = Partial<Record<"prod" | "test" | "local", string | string[]>>;
export const port = (
  name: string, purpose: string, methods: string[], adapters: Adapters, o: Located & { injected?: boolean } = {},
): Port => ({
  kind: "port", name, purpose, methods, injected: o.injected ?? true, sources: o.sources, note: o.note,
  adapters: (["prod", "local", "test"] as const).flatMap((env) => [adapters[env] ?? []].flat().map((n) => ({ name: n, env }))),
});

// ---- observability ----
// metric("signing_delegations_total", "Signing.Delegate", ["outcome"], { alert: "errors > 5% for 10m" })
const sig = (type: Signal["type"]) =>
  (name: string, on: string, fieldNames: string[] = [], o: Located & { alert?: string } = {}): Signal =>
    ({ kind: "signal", type, name, on, fields: fieldNames, ...o });

export const log = sig("log");
export const metric = sig("metric");
export const trace = sig("trace");
export const audit = sig("audit");

// ---- testing ----
// test("delegating twice is refused", "unit", ["Signing.Delegate"], { fakes: ["Mailer"] })
export const test = (
  name: string, level: TestCase["level"], covers: string | string[],
  o: Located & { fakes?: string[]; exists?: boolean } = {},
): TestCase => ({
  kind: "test", name, level, covers: typeof covers === "string" ? [covers] : covers,
  fakes: o.fakes ?? [], exists: o.exists, sources: o.sources, note: o.note,
});
