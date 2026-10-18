---
name: seams
description: Map a TypeScript codebase into a plan document (modules, data, contracts) for a change the user describes, or to explain how part of it works, and render it as one standalone HTML page.
---

# Plan documents

A plan document is the reference for one planning or learning session. It holds the system's
module boundaries, the data each module owns, and the contracts between them, as a tree you write
in TypeScript with the seams DSL. The CLI checks the tree and renders one HTML file that a
person reviews and that you read back on the next round.

It needs the `plan` command (from the seams repo, installed with `npm link`). If `seams where`
fails, tell the user to install seams first (see its README) and stop.

## When to use it

- The user describes a change and wants it planned at the level of boundaries and responsibilities
  (mode `plan`).
- The user wants to understand how a part of the system hangs together (mode `learn`: no
  `proposed` tree).

## The resolution to aim for

The plan is a conceptual model, not a transcript of the code. Get these right and leave the rest out:

1. **Modules and who depends on whom.** A module is a responsibility with a boundary, not a folder.
   Name it for what it is responsible for. Folders, packages and layers (API, jobs, utils) are
   evidence, not modules.
2. **Data ownership.** Each table belongs to exactly one module, the one whose rules decide how it
   changes. Tables that change together under shared invariants form an aggregate, loaded and
   saved through its root.
3. **Contracts.** What a module promises others: commands, queries with their errors, events, and
   the DTO types they use. Never expose a table type in a contract.
4. **Storage.** For each mapped module that owns data, the store that holds it: engine, table
   names, the indexes or key templates the access patterns rely on, and column types only where
   they differ from the default. Read these from the schema or migrations; do not invent indexes.
5. **Endpoints.** The routes and procedures near the change, with protocol, method, path, auth and
   the operations they call. An API layer that only routes is its own module that owns endpoints
   and no data.
6. **Wiring.** The ports a mapped module needs from outside the domain (jobs, mailer, clock, file
   store, PDF signer), their adapters per environment, and whether the code passes them in or
   imports a singleton. Other modules are injected through `uses`; do not repeat them as ports.
7. **Observability.** The signals near the change: audit records, logs, metrics, traces, each on
   the operation, event, endpoint or port that emits it, with its fields. Model what exists, then
   add what the change needs so someone can tell it works in production.
8. **Testing strategy.** The tests that already cover the area (`exists: true`, with a source)
   and the ones the change needs: one per new command and per new invariant, at the lowest level
   that proves it, faking only ports and used contracts.

Leave out function bodies, frameworks, infrastructure, UI, and any field or operation the intent
does not touch. Three to six fields per table is usually right; keep the ones the change reads,
writes or keys on.

## Lazy mapping

Map only what the intent needs, in this order, and stop as soon as the change is clear:

1. Read the repo's own map first: README, ARCHITECTURE or AGENTS files, the package list, the
   schema file (Prisma, Drizzle, SQL migrations).
2. Find the closest existing feature to the change (a similar flow, a similar setting) and read
   it end to end. It shows which tables, side effects and callers the change will touch.
3. **Mapped** modules are the ones the change touches or that call what changes. Give them
   entities, aggregates, repositories and contracts.
4. **Stub** modules are everything else the mapped ones talk to: `stub(name, purpose, contracts,
   sources, uses)`. Name them so the graph is honest; do not fill them in.
5. Do not read a stub's code. If a question needs it, map it then.

## Where the code does not fit the model

Real code often breaks the rules the model enforces: every module queries the database directly,
side effects are triggered by job name, one table is written from twenty files. Do not bend the
model to match. Model the boundary as it should be read, and put what the code actually does in a
`note` on the node, with a source. Prefer facts over adjectives: "Recipient rows are written from
29 files in 10 folders (grep)", not "ownership is leaky".

When the code depends on another module the model leaves out on purpose (a direct call where the
plan says "event"), declare it on the module: `gaps: [gap("Webhooks", "calls triggerWebhook directly")]`.
`seams verify` accepts those imports and nothing else, so every shortcut in the code is either a
declared dependency or a named gap.

Side effects that need no answer (emails, webhooks, audit) are events from the module that
decides they happen, subscribed to by the module that performs them, even when the code calls
them directly. Say so in a note.

## Writing the document

Start the file with `seams new <slug>` (or `seams new <slug> --learn`) in the user's working folder.
It writes `plans/<slug>.plan.ts` with the imports and every section in place. Its default export is
a `PlanDocument`; the DSL helpers are documented in `$(seams where)/src/dsl.ts`.

Build the current modules once, then build the proposed
tree by replacing only the modules that change (spread the current one and override), so
unchanged modules are written once.

- `sources`: `src(path, symbol?)` on every mapped module, contract and table you read, so a reader
  can jump to the code. Paths are repo-relative.
- `note`: where the code differs from the model, or anything surprising.
- Aggregates: `aggregate(root, members, invariants)`. Write the invariants as rules the code must
  keep, in plain sentences. A root can be found through a member: `findBy("Recipient.token")`.
- `slices`: phases that can ship on their own, in order, each listing the node ids it covers
  (`Module`, `Module/Sub`, `Module/entity/X`, `Module/contract/C/Op`, `.../type/T`). Every change
  in the diff should fall in a slice.
- `decisions`: the forks you settled while mapping, each with its reason.
- `questions`: the forks only the user can settle, each with two or three options and the node
  it is about. Ask about behaviour and boundaries, not naming.
- Stores: `store("main database", "postgres", [table("Recipient", "Recipient", { indexes: [idx("token")] })])`
  or, for DynamoDB, `table("Payment", "payments", { pk: "PAY#{id}", gsis: [{ name: "byOrder", pk: "ORDER#{orderId}" }] })`.
  When an entity is bound, put its indexes on the binding only, not on the entity.
- Endpoints: `http("POST", "/api/v2/envelope/distribute", "Envelopes.Send", { auth: "api token" })` or
  `rpc("trpc", "recipient.rejectDocumentWithToken", "Signing.Reject", { auth: "recipient token" })`.
  List the ones near the change, not every route.
- Ports: `port("Jobs", "Queues background work", ["triggerJob({ name, payload })"], { prod: "Inngest", local: "LocalJobProvider" }, { injected: false })`.
  Set `injected: false` when the code imports the implementation directly.
- Signals: `audit(name, on, fields)`, `log(...)`, `metric(...)`, `trace(...)`. `on` is `"Contract.Op"`,
  `"Contract.Event"`, an endpoint name or a port. Never list a token, password or secret as a field.
  Keep metric labels to a few values each (outcome, provider), never ids or emails.
- Tests: `test("delegating twice is refused", "unit", ["Signing.Delegate", "Envelope"], { fakes: ["Jobs"] })`.
  `covers` takes operations, events, endpoint names and aggregates (meaning their invariants).
  If a test needs to fake a port the code imports directly, that is a question for the user.
- `glossary`: the domain's own words a newcomer would trip on (eight to twelve), each with a
  one-sentence meaning and the node that embodies it. The page underlines them everywhere.
- `facts`: deterministic evidence keyed by node id (counts, complexity, call sites). Say how each
  was measured in `detail`. Never make one up.

## Check, render, read back

```sh
seams check  plans/<slug>.plan.ts
seams render plans/<slug>.plan.ts          # writes plans/<slug>.plan.html
seams read   plans/<slug>.plan.html --outline
```

Then hold the map to the code, from the repository root:

```sh
seams verify plans/<slug>.plan.ts          # the current tree must match the code
```

It checks that every `src()` exists and names a real symbol, that imports between module folders
go through a declared `uses` or a `gap()`, that tables, columns and indexes exist in
`schema.prisma`, and that each operation has code. Do not show the user a plan whose current tree
fails verify: fix the map, add the missing `src()`, or declare the gap.

`render` refuses a plan with errors. Fix errors by changing the model, not by deleting the rule's
subject: an error usually means a boundary is wrong (a cycle, a module reaching into another's
table). Warnings are findings; keep the ones that describe the real code and mention them.

Then read the outline back and check it against the intent: every part of the intent should land
on a node, and every change in the change list should be one you meant.

## Building the change

The plan is the spec, and it must still be true when the change is done. Build one slice at a time.
For each slice:

1. Write the code.
2. Point every new operation and endpoint at the code that implements it with `src()`. Verify
   refuses a new one without it.
3. Run `seams verify plans/<slug>.plan.ts --tree proposed`. Its errors are the slice's remaining
   work: columns not yet in the schema, operations with no code, imports with no declared
   dependency.
4. If the code had to differ from the plan, change the plan to match and render again, so the page
   always shows what was built. Tell the user what changed and why. Never leave the two apart.

The change is done when `seams verify --tree proposed` passes and the planned tests exist (mark
them `exists: true` with a `src()`).

## On the next round

The user may come back with the HTML file and notes copied from its sidebar (each note names a
node id). Read the document with `read <file>.plan.html`, apply the notes to the `.plan.ts`, and
render again to the same path. Answered questions become decisions.

## Reporting

Give the user the HTML file and a few lines: the modules you mapped, what changes, and the open
questions. Do not restate the document.
