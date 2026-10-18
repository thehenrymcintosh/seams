# plan-ast: a planning model for TypeScript systems

A first prototype of a planning representation that sits above code. A plan is
a typed tree (an AST) holding only the decisions that matter at the module
level, in the three categories:

1. **Data**: how it is stored and accessed (entities, keys, indexes, repositories)
2. **Module split**: which modules exist and who depends on whom
3. **Contracts**: what each module promises the others (operations, errors, events, DTO types)

Nothing else goes in the plan. Function bodies, frameworks and infrastructure
stay in code. Every other format (diagram, spec, code skeleton, change review)
is a **view** derived from the tree, so there is one source of truth and the
right view can be picked per context.

## Layout

| File | What it is |
| --- | --- |
| `src/ast.ts` | The node types. Start here. |
| `src/dsl.ts` | Small helpers so a plan reads like a spec. Plans stay plain data. |
| `src/check.ts` | The rules that keep modules tidy. |
| `src/views/mermaid.ts` | Diagram view: system graph and per-module ER diagrams. |
| `src/views/spec.ts` | Text view: a reviewable Markdown spec. |
| `src/views/skeleton.ts` | Code view: a TypeScript skeleton that typechecks. |
| `src/views/diff.ts` | Change view: diff two plans, tag each change by its cost. |
| `examples/shop.v1.ts` | Worked example: Catalog and Orders. |
| `examples/shop.v2.ts` | The planned change: add Payments. |
| `examples/shop.tangled.ts` | A bad version of v2, to show the checker. |
| `src/ids.ts` | Stable node ids that notes, slices and diffs refer to. |
| `src/doc.ts` | The plan document format: intent, current and proposed trees, slices, questions, decisions, code facts. |
| `src/render/` | Renders a plan document to one standalone HTML file (`render.ts`, `viewmodel.ts`, inline `client.js` and `client.css`). |
| `src/cli.ts` | `render`, `read` and `check` for plan documents. |
| `examples/shop.doc.ts` | The worked example as a plan document, with two stub modules. |
| `docs/app-pitch.md` | Where this is heading: a skill that writes plan documents, with its own review loop. |
| `out/` | Everything `run.ts` renders, including `shop-payments.plan.html`. |

Run it with Node 22.18+ (no build step; Node runs the `.ts` files directly):

```sh
node run.ts            # renders out/
npm install && npm run typecheck   # typechecks the prototype and the generated skeleton
```

## Plan documents

A plan document is one HTML file that opens in any browser and makes no network requests.
It carries the plan three ways:

- **For people:** one pannable, zoomable canvas. Modules are cards placed as a graph (springs
  along calls, events and shared types; cards never overlap; drag one and it stays put).
  Everything starts collapsed. Contracts and stored tables are rows that expand in place; types open as cards under the contract that defines them and wire back to every use
  in other modules. Changes are shown on the node they affect, and new dependencies are drawn as
  green wires. Phases, open questions and decisions sit below the canvas in collapsible sections. A thin sidebar holds
  the conversation: click anything to attach a note to it.
- **For an agent:** `#plan-outline`, a compact text outline (`src/views/outline.ts`). Every line
  starts with a node id, signatures are TypeScript-shaped, the rules the code must follow are at
  the top, and the change list is stated once. This is the reference to validate code against.
- **As the source:** `#plan-doc`, the document as JSON, which is what gets edited and re-rendered.

```sh
node src/cli.ts render plan.json -o plan.html   # refuses if the plan breaks a rule (--force to show it anyway)
node src/cli.ts read plan.html                   # the embedded document back out, as JSON
node src/cli.ts read plan.html --outline         # the agent outline
node src/cli.ts check plan.html
```

## The model in one paragraph

Ownership is structural. An entity sits inside the module that owns it, and a
contract sits inside the module that provides it, so "who owns this table" is
not a convention, it is the shape of the tree. The only edges that cross
module boundaries are `uses` (depend on another module's contract, optionally
subscribing to its events) and qualified type references such as
`Catalog.ProductSummary`, which are only legal through a contract you use.
Repositories declare access patterns (`get`, `findBy("customerId")`, `save`)
rather than queries, so the plan knows every way a module touches its data.

## Boundaries inside a module

- **Sub-modules** nest inside a module (`modules: [...]`). Their contracts are visible to the
  parent and its other sub-modules, never from outside: from outside, only the parent's own
  contracts count. In code they become folders inside the parent's (`payments/gateway/`).
- **Aggregates** group tables that change together (`aggregate("Order", ["OrderLine"], invariants)`).
  Only the root has a repository, and it loads and saves the whole aggregate
  (`OrderRepository.get(): OrderAggregate`). Invariants are written down on the aggregate and
  carried into the generated types as comments.

## What the checker enforces

Run on `examples/shop.tangled.ts` (output in `out/tangled-check.txt`):

```
warning Payments / PaymentRepository
        findBy orderId has no supporting index on Payment
error   Payments / OrderRepository
        reaches into storage owned by Orders; go through the Orders module's contract instead
error   Payments / contract Payments / StartPayment -> output
        exposes storage entity "Order"; define a contract type instead
error   Orders -> Payments -> Orders
        dependency cycle between modules
```

The full list: references resolve; one owner per entity; repositories only
touch their own module's entities; every `findBy` is backed by the key or an
index; contracts never expose storage entities; cross-module types need a
declared dependency; subscribed events exist; no dependency cycles; a module
that owns data provides some contract.

## Views

- **Diagram** (`out/v2/system.mmd`, and inside each spec): modules with the data they own and the contracts they provide, arrows for calls and dashed arrows for events.
- **Spec** (`out/v2/spec.md`): per module, its purpose, dependencies, ER diagram, access patterns and contract signatures.
- **Code skeleton** (`out/v2/skeleton/`): one folder per module. `*.contract.ts` is public; `schema.ts` and `repositories.ts` are private; `index.ts` is the wiring (`createOrders(deps)` takes the contracts it uses and its repositories, returns its Api and event handlers). Cross-module imports are only ever `import type * as X from "../x/X.contract.ts"`, so the boundary can be linted. Errors are part of the contract and come out as `Result<T, "NotFound" | ...>`.
- **Change review** (`out/change-v1-to-v2.md`): a planned change is a diff between two plans. Each line is tagged `breaking`, `migration`, `additive` or `internal`, and consumers who must change are listed first. It also catches cross-category effects, e.g. dropping the `Placed` value from the `OrderStatus` contract type is flagged as a data migration because the `Order` entity stores it.

## Known gaps and next questions

- **Plan and code drift.** Today the skeleton is generated one way. The obvious next step is the reverse: extract a plan from existing TypeScript (contract files and the import graph) and diff it against the intended plan, so the plan stays true after code is written.
- **Authoring format.** Plans are written as TypeScript with a small DSL, which gives type safety and autocomplete for free. A visual editor or a YAML form could sit on the same AST later.
- **Nesting.** Modules are flat. Sub-modules (a module that is itself a small plan) are the natural extension once a system gets bigger.
- **Not modelled yet:** transactions and consistency boundaries, sync vs. async calls, versioning of contracts, non-functional notes (latency, volume) on access patterns.
- **AI use.** The checker's rules are exactly the assumptions an agent could rely on: a change scoped to one module only touches its folder, and a change to a `*.contract.ts` file is the only kind that needs cross-module review.
