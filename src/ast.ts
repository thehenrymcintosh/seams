// The planning AST.
//
// A plan is a tree, and ownership is structural: an entity lives inside the
// module that owns it, a contract lives inside the module that provides it.
// The only edges that cross module boundaries are `uses` (a dependency on
// another module's contract) and qualified type references into a used
// contract ("Catalog.ProductSummary"). Everything else the checker enforces.
//
// The three decision categories map to three parts of a Module:
//   1. data storage + access  -> entities, repositories
//   2. module split           -> the Module nodes themselves, plus `uses`
//   3. contracts              -> provides (operations, events, DTO types)

export type Plan = {
  kind: "plan";
  name: string;
  modules: Module[];
};

// Every node may say where it lives in the code and add a caveat. The tree is
// a conceptual model, so sources are best effort and a module can map to
// several folders or part of one.
export type Located = {
  sources?: SourceRef[];
  note?: string;
};

export type SourceRef = { path: string; symbol?: string; line?: number };

export type Module = Located & {
  kind: "module";
  name: string;
  purpose: string;
  // "stub" = named and placed, not yet read in detail. The mapping agent
  // builds the tree lazily: deep where the change is, stubs elsewhere.
  depth: "stub" | "mapped";
  entities: Entity[];
  aggregates: Aggregate[];
  repositories: Repository[];
  provides: Contract[];
  uses: Use[];
  // Sub-modules sit inside this module's boundary. Their contracts are
  // visible to their siblings and to this module, but not to anything
  // outside it: from outside, only this module's own contracts count.
  modules: Module[];
};

// ---- 1. Data: storage and access -------------------------------------------

export type Entity = Located & {
  kind: "entity";
  name: string;
  doc?: string;
  fields: Field[];
  key: string[];
  indexes: Index[];
};

export type Index = { fields: string[]; unique?: boolean };

// A consistency boundary: entities that change together in one transaction,
// loaded and saved only through the root. Members are reached through the
// root's repository, and nothing outside holds a reference to a member,
// only to the root's id.
export type Aggregate = Located & {
  kind: "aggregate";
  name: string;
  root: string;            // entity name
  members: string[];       // other entity names inside the boundary
  invariants: string[];    // what must hold whenever the aggregate is saved
};

// Access patterns are declared, not written. Signatures are derived from the
// entity, so the plan knows every query a module makes and can check that
// each one is backed by the key or an index.
export type Repository = {
  kind: "repository";
  name: string;
  entity: string;
  methods: RepoMethod[];
};

export type RepoMethod =
  | { kind: "get" }                          // by primary key -> Entity | null
  | { kind: "find"; by: string[] }           // by fields      -> Entity[]
  | { kind: "save" }                         // upsert
  | { kind: "delete" };                      // by primary key

// ---- 3. Contracts between modules --------------------------------------------

export type Contract = Located & {
  kind: "contract";
  name: string;
  types: TypeDef[];
  operations: Operation[];
  events: EventDef[];
};

export type Operation = {
  kind: "operation";
  name: string;
  mode: "command" | "query";
  input: Field[];
  output: TypeExpr | null;
  errors: string[];
};

export type EventDef = { kind: "event"; name: string; payload: Field[] };

export type TypeDef =
  | { kind: "record"; name: string; fields: Field[] }
  | { kind: "enum"; name: string; values: string[] };

// ---- 2. Module split: the only cross-module edge ------------------------------

export type Use = {
  contract: string;        // name of a contract provided by another module
  subscribes: string[];    // event names on that contract this module reacts to
};

// ---- Shared ---------------------------------------------------------------

export type Field = { name: string; type: TypeExpr; doc?: string };

export type Primitive = "string" | "int" | "decimal" | "boolean" | "datetime" | "uuid";

export type TypeExpr =
  | { kind: "prim"; name: Primitive }
  | { kind: "ref"; name: string }            // "Local" or "Contract.Type"
  | { kind: "list"; of: TypeExpr }
  | { kind: "optional"; of: TypeExpr };
