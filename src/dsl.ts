// A thin authoring layer over the AST. Plans stay plain data; these helpers
// only fill in `kind` tags and defaults so a plan reads like a spec.

import type {
  Aggregate, Contract, Entity, EventDef, Field, Index, Module, Operation, Plan,
  Primitive, RepoMethod, Repository, SourceRef, TypeDef, TypeExpr, Use,
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
  modules: [],
});
