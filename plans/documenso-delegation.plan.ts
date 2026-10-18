// Mapped from documenso/documenso @ 8724500 with the seams skill.
// Intent: let a signer hand their signing over to someone else.

import type { Module } from "../src/ast.ts";
import type { PlanDocument } from "../src/doc.ts";
import {
  aggregate, audit, command, contract, entity, enumOf, event, findBy, get, http, idx, log, module, plan, port, query, record,
  repo, rpc, save, src, store, stub, subscribe, t, table, test, uniqueIdx,
} from "../src/dsl.ts";

const lib = "packages/lib/server-only";

// --- Envelopes: the document being prepared, sent and signed --------------

const signingOrder = module("SigningOrder", {
  purpose: "Decides whose turn it is. Pure rules over the recipients of one envelope; owns no data.",
  sources: [src(`${lib}/recipient/get-is-recipient-turn.ts`), src(`${lib}/recipient/get-next-pending-recipient.ts`), src("packages/lib/utils/recipients.ts")],
  provides: [
    contract("SigningOrder", {
      operations: [
        query("IsRecipientTurn", { envelopeId: t.string, recipientId: t.int }, t.boolean),
        query("NextPendingRecipients", { envelopeId: t.string }, t.list(t.int)),
      ],
    }),
  ],
});

const auditTrail = module("AuditTrail", {
  purpose: "Append-only record of everything that happened to an envelope. Feeds the signing certificate.",
  sources: [src("packages/lib/types/document-audit-logs.ts"), src("packages/lib/utils/document-audit-logs.ts", "createDocumentAuditLogData")],
  note: "In code every flow inserts DocumentAuditLog rows itself, inside the same Prisma transaction as the change it records.",
  entities: [
    entity("DocumentAuditLog", {
      id: t.string, envelopeId: t.optional(t.string), type: t.string, data: t.string, email: t.optional(t.string), createdAt: t.datetime,
    }, { doc: "type is a free-text column; the list of types lives in code, so adding one needs no migration." }),
  ],
  repositories: [repo("DocumentAuditLog", [save, findBy("envelopeId")])],
  stores: [store("main database", "postgres", [
    table("DocumentAuditLog", "DocumentAuditLog", { indexes: [idx("envelopeId")], columns: [{ field: "data", type: "jsonb" }] }),
  ], { note: "The same Postgres database as Envelopes; this module owns only its table." })],
  provides: [
    contract("AuditTrail", {
      types: [
        enumOf("AuditType", ["DOCUMENT_SENT", "DOCUMENT_OPENED", "DOCUMENT_RECIPIENT_COMPLETED", "DOCUMENT_RECIPIENT_REJECTED", "RECIPIENT_UPDATED", "DOCUMENT_COMPLETED"]),
        record("AuditEntry", { type: t.ref("AuditType"), actorEmail: t.string, data: t.string }),
      ],
      operations: [
        command("Append", { envelopeId: t.string, entry: t.ref("AuditEntry") }, null),
        query("List", { envelopeId: t.string }, t.list(t.ref("AuditEntry"))),
      ],
    }),
  ],
});

const sealing = stub("Sealing", "Burns signatures into the PDF and signs it once every recipient has acted.", ["Sealing"],
  [src("packages/lib/jobs/definitions/internal/seal-document.handler.ts")]);

const envelopeFields = {
  envelope: entity("Envelope", {
    id: t.string, teamId: t.int, userId: t.int, status: t.ref("EnvelopeStatus"), title: t.string, documentMetaId: t.string,
  }, { sources: [src("packages/prisma/schema.prisma", "Envelope", 449)] }),
  meta: entity("DocumentMeta", {
    id: t.string, signingOrder: t.ref("SigningOrderMode"), allowDictateNextSigner: t.boolean, distributionMethod: t.string,
  }, { sources: [src("packages/prisma/schema.prisma", "DocumentMeta", 575)], doc: "Per-envelope settings. Team and organisation settings hold the defaults." }),
  recipientShape: {
    id: t.int, envelopeId: t.string, email: t.string, name: t.string, token: t.string, role: t.ref("RecipientRole"),
    signingStatus: t.ref("SigningStatus"), signingOrder: t.optional(t.int), expiresAt: t.optional(t.datetime),
  },
  field: entity("Field", {
    id: t.int, envelopeId: t.string, recipientId: t.int, type: t.string, inserted: t.boolean,
  }, { sources: [src("packages/prisma/schema.prisma", "Field", 703)] }),
  signature: entity("Signature", {
    id: t.int, fieldId: t.int, recipientId: t.int, created: t.datetime,
  }, { sources: [src("packages/prisma/schema.prisma", "Signature", 728)] }),
};

// Prisma names tables after models and indexes "<Model>_<columns>_idx".
const pidx = (t: string, ...on: string[]) => ({ ...idx(...on), name: `${t}_${on.join("_")}_idx` });
const mainDb = () => store("main database", "postgres", [
  table("Envelope", "Envelope", {
    indexes: [pidx("Envelope", "teamId"), pidx("Envelope", "status"), pidx("Envelope", "userId")],
    columns: [{ field: "status", type: '"DocumentStatus"' }],
  }),
  table("DocumentMeta", "DocumentMeta", { columns: [{ field: "signingOrder", type: '"DocumentSigningOrder"' }, { field: "distributionMethod", type: '"DocumentDistributionMethod"' }] }),
  table("Recipient", "Recipient", {
    indexes: [
      pidx("Recipient", "token"), pidx("Recipient", "envelopeId"), pidx("Recipient", "email"), pidx("Recipient", "expiresAt"),
      pidx("Recipient", "email", "signingStatus", "envelopeId", "role"),
      { name: "Recipient_email_trgm_idx", on: ["email"], using: "gin" },
    ],
    columns: [{ field: "email", type: "varchar(255)" }, { field: "name", type: "varchar(255)" }],
    note: "Eleven indexes in the schema; the ones lookups here rely on are listed.",
  }),
  table("Field", "Field", { indexes: [pidx("Field", "envelopeId"), pidx("Field", "recipientId")], columns: [{ field: "type", type: '"FieldType"' }] }),
  table("Signature", "Signature", { indexes: [{ ...uniqueIdx("fieldId"), name: "Signature_fieldId_key" }, pidx("Signature", "recipientId")] }),
], { sources: [src("packages/prisma/schema.prisma")], note: "One PostgreSQL database for the whole app, reached through Prisma and Kysely." });

const recipientNote = "Recipient rows are written from 29 files in 10 folders, including the document flows, templates, jobs and admin (grep for prisma/tx.recipient writes). The plan treats Envelopes as their one owner.";

const invariants = [
  "Recipients can only act while the envelope is PENDING.",
  "A recipient's signingStatus moves from NOT_SIGNED to SIGNED or REJECTED, never back.",
  "Every field belongs to a recipient of the same envelope, and a signature only fills that recipient's field.",
  "With SEQUENTIAL signing order, only recipients whose turn it is can act (SigningOrder decides).",
];

const envelopeContract = (o: { status: string[]; recipientView: Record<string, ReturnType<typeof t.ref> | typeof t.int>; settings: Record<string, any>; events: ReturnType<typeof event>[] }) =>
  contract("Envelopes", {
    sources: [src("packages/trpc/server/envelope-router/router.ts"), src(`${lib}/document/send-document.ts`, "sendDocument")],
    types: [
      enumOf("EnvelopeStatus", ["DRAFT", "PENDING", "COMPLETED", "REJECTED", "CANCELLED"]),
      enumOf("RecipientRole", ["SIGNER", "APPROVER", "VIEWER", "ASSISTANT", "CC"]),
      enumOf("SigningStatus", o.status),
      enumOf("SigningOrderMode", ["PARALLEL", "SEQUENTIAL"]),
      record("RecipientInput", { email: t.string, name: t.string, role: t.ref("RecipientRole"), signingOrder: t.optional(t.int) }),
      record("RecipientView", o.recipientView),
      record("EnvelopeSettings", o.settings),
      record("EnvelopeView", { id: t.string, title: t.string, status: t.ref("EnvelopeStatus"), recipients: t.list(t.ref("RecipientView")) }),
    ],
    operations: [
      query("GetEnvelope", { envelopeId: t.string }, t.ref("EnvelopeView"), ["NotFound"]),
      command("SetRecipients", { envelopeId: t.string, recipients: t.list(t.ref("RecipientInput")) }, t.list(t.ref("RecipientView")), ["NotFound", "NotEditable"]),
      command("UpdateSettings", { envelopeId: t.string, settings: t.ref("EnvelopeSettings") }, null, ["NotFound", "NotEditable"]),
      command("Send", { envelopeId: t.string }, t.ref("EnvelopeView"), ["NotFound", "AlreadySent", "MissingFields"]),
      command("Cancel", { envelopeId: t.string, reason: t.string }, null, ["NotFound", "NotPending"]),
      query("ListAuditLog", { envelopeId: t.string }, t.list(t.ref("AuditTrail.AuditEntry")), ["NotFound"]),
    ],
    events: o.events,
  });

const baseEvents = [
  event("SigningRequested", { envelopeId: t.string, recipientId: t.int }),
  event("RecipientCompleted", { envelopeId: t.string, recipientId: t.int }),
  event("RecipientRejected", { envelopeId: t.string, recipientId: t.int, reason: t.string }),
  event("EnvelopeCompleted", { envelopeId: t.string }),
  event("EnvelopeRejected", { envelopeId: t.string }),
];

const signingContract = (extra: { ops?: ReturnType<typeof command>[]; types?: ReturnType<typeof record>[] } = {}) =>
  contract("Signing", {
    sources: [src("packages/trpc/server/recipient-router/router.ts", "completeDocumentWithToken"), src(`${lib}/document/reject-document-with-token.ts`)],
    note: "Every operation here is authorised by the recipient's token, not a session.",
    types: [
      record("SigningSession", { envelopeId: t.string, recipientId: t.int, role: t.ref("Envelopes.RecipientRole"), isTurn: t.boolean }),
      ...(extra.types ?? []),
    ],
    operations: [
      query("GetSession", { token: t.string }, t.ref("SigningSession"), ["NotFound", "Expired"]),
      command("SignField", { token: t.string, fieldId: t.int, value: t.string }, null, ["NotFound", "Expired", "NotYourTurn", "AlreadyInserted"]),
      command("Complete", { token: t.string, nextSignerEmail: t.optional(t.string) }, null, ["NotFound", "Expired", "NotYourTurn", "MissingFields", "AlreadyActioned"]),
      command("Reject", { token: t.string, reason: t.string }, null, ["NotFound", "Expired", "NotPending", "AlreadyActioned"]),
      ...(extra.ops ?? []),
    ],
  });

const envelopesSources = [src("packages/prisma/schema.prisma", "Envelope"), src(`${lib}/envelope/`), src(`${lib}/document/`), src(`${lib}/recipient/`), src(`${lib}/field/`)];
const envelopesNote = "In code, document functions enqueue email jobs by name (jobs.triggerJob('send.signing.requested.email'), 22 files) and call triggerWebhook directly (17 files). The plan models both as events.";

// Every flow enqueues its side effects through one jobs client, imported as a
// module singleton. Tests can only replace it with vi.mock.
const jobsPort = port("Jobs", "Queues background work: emails, webhook calls, sealing.", ["triggerJob({ name, payload })"],
  { prod: ["Inngest", "BullMQ"], local: "LocalJobProvider" },
  { injected: false, sources: [src("packages/lib/jobs/client.ts", "jobsClient", 43)],
    note: "The provider is picked by NEXT_PRIVATE_JOBS_PROVIDER. 21 files under server-only import `jobs` directly." });
const rejectAudit = audit("recipient rejected", "Signing.Reject", ["envelopeId", "recipientId", "reason", "ipAddress", "userAgent"],
  { sources: [src(`${lib}/document/reject-document-with-token.ts`, "createDocumentAuditLogData", 78)], note: "Written as a DocumentAuditLog row in the same transaction. Feeds the signing certificate." });
const rejectE2e = test("no step is activated past a rejected recipient", "e2e", "Signing.Reject",
  { exists: true, sources: [src("packages/app-tests/e2e/recipient/rejected-recipient-advancement.spec.ts", undefined, 37)] });

const envelopesV1 = module("Envelopes", {
  purpose: "A document or template being prepared, sent and signed: its recipients, their fields and signatures, and the rules for who acts when.",
  sources: envelopesSources,
  note: envelopesNote,
  entities: [
    envelopeFields.envelope, envelopeFields.meta,
    entity("Recipient", envelopeFields.recipientShape, { sources: [src("packages/prisma/schema.prisma", "Recipient", 646)], note: recipientNote }),
    envelopeFields.field, envelopeFields.signature,
  ],
  aggregates: [aggregate("Envelope", ["DocumentMeta", "Recipient", "Field", "Signature"], invariants)],
  repositories: [repo("Envelope", [get, findBy("teamId"), findBy("Recipient.token"), save])],
  stores: [mainDb()],
  modules: [signingOrder, auditTrail, sealing],
  uses: ["SigningOrder", "AuditTrail", "Sealing", "Accounts"],
  ports: [jobsPort],
  signals: [rejectAudit],
  tests: [rejectE2e],
  provides: [
    envelopeContract({
      status: ["NOT_SIGNED", "SIGNED", "REJECTED"],
      recipientView: { id: t.int, email: t.string, name: t.string, role: t.ref("RecipientRole"), signingStatus: t.ref("SigningStatus") },
      settings: { signingOrder: t.ref("SigningOrderMode"), allowDictateNextSigner: t.boolean },
      events: baseEvents,
    }),
    signingContract(),
  ],
});

// --- Side effects ------------------------------------------------------------

const emailsV1 = module("Emails", {
  purpose: "Sends every email about an envelope: signing requests, confirmations, notices to the sender.",
  sources: [src("packages/lib/jobs/definitions/emails/"), src("packages/email/templates/")],
  note: "Each email is a background job whose handler reads the envelope through Prisma itself. Conceptually it reads through GetEnvelope.",
  uses: [subscribe("Envelopes", "SigningRequested", "RecipientCompleted", "RecipientRejected", "EnvelopeCompleted")],
  ports: [port("Mailer", "Sends one rendered email.", ["sendMail({ to, from, subject, html, text })"],
    { prod: ["SMTP", "Resend", "MailChannels"], local: "SMTP on 127.0.0.1:2500" },
    { injected: false, sources: [src("packages/email/mailer.ts", "mailer", 108)], note: "Chosen by NEXT_PRIVATE_SMTP_TRANSPORT and imported directly in 11 files." })],
});

const webhookEvents = ["DOCUMENT_SENT", "DOCUMENT_OPENED", "DOCUMENT_SIGNED", "DOCUMENT_RECIPIENT_COMPLETED", "DOCUMENT_COMPLETED", "DOCUMENT_REJECTED", "DOCUMENT_CANCELLED", "RECIPIENT_EXPIRED"];

const webhooks = (events: string[], on: string[]) => module("Webhooks", {
  purpose: "Lets a team register URLs for envelope events, and delivers and logs each call.",
  sources: [src(`${lib}/webhooks/`), src(`${lib}/webhooks/trigger/trigger-webhook.ts`, "triggerWebhook")],
  entities: [
    entity("Webhook", { id: t.string, teamId: t.int, webhookUrl: t.string, eventTriggers: t.list(t.ref("WebhookEvent")), enabled: t.boolean },
      { sources: [src("packages/prisma/schema.prisma", "Webhook", 184)], note: "Looked up by team and event on every trigger (get-all-webhooks-by-event-trigger.ts) with no index on teamId." }),
    entity("WebhookCall", { id: t.string, webhookId: t.string, event: t.ref("WebhookEvent"), status: t.string, responseCode: t.int, createdAt: t.datetime },
      { sources: [src("packages/prisma/schema.prisma", "WebhookCall", 204)] }),
  ],
  repositories: [repo("Webhook", [get, findBy("teamId"), save]), repo("WebhookCall", [findBy("webhookId"), save])],
  stores: [store("main database", "postgres", [
    table("Webhook", "Webhook", { columns: [{ field: "eventTriggers", type: '"WebhookTriggerEvents"[]' }] }),
    table("WebhookCall", "WebhookCall", { columns: [{ field: "event", type: '"WebhookTriggerEvents"' }, { field: "status", type: '"WebhookCallStatus"' }] }),
  ], { note: "Neither table declares an index besides its key." })],
  uses: [subscribe("Envelopes", ...on)],
  provides: [
    contract("Webhooks", {
      types: [
        enumOf("WebhookEvent", events),
        record("WebhookView", { id: t.string, webhookUrl: t.string, eventTriggers: t.list(t.ref("WebhookEvent")), enabled: t.boolean }),
      ],
      operations: [
        command("CreateWebhook", { teamId: t.int, webhookUrl: t.string, eventTriggers: t.list(t.ref("WebhookEvent")) }, t.ref("WebhookView"), ["InvalidUrl"]),
        query("ListForTeam", { teamId: t.int }, t.list(t.ref("WebhookView"))),
      ],
    }),
  ],
});
const webhookSubs = ["SigningRequested", "RecipientCompleted", "RecipientRejected", "EnvelopeCompleted", "EnvelopeRejected"];

// --- Named, not mapped ---------------------------------------------------------

const accounts = stub("Accounts", "Users, teams and organisations, their members and the default settings a team gives new envelopes.",
  ["Accounts"], [src(`${lib}/team/`), src(`${lib}/organisation/`), src(`${lib}/user/`)]);
const templates = stub("Templates", "Reusable envelopes, direct links and bulk send. Creates envelopes from a template.",
  [], [src(`${lib}/template/`)], ["Envelopes"]);
const v2 = (method: "GET" | "POST", path: string, calls: string, file: string) =>
  http(method, `/api/v2${path}`, calls, { auth: "api token or session", audience: "public", sources: [src(`packages/trpc/server/envelope-router/${file}.types.ts`)] });
const apiEndpoints = [
  v2("GET", "/envelope/{envelopeId}", "Envelopes.GetEnvelope", "get-envelope"),
  v2("POST", "/envelope/update", "Envelopes.UpdateSettings", "update-envelope"),
  v2("POST", "/envelope/distribute", "Envelopes.Send", "distribute-envelope"),
  v2("POST", "/envelope/cancel", "Envelopes.Cancel", "cancel-envelope"),
  v2("GET", "/envelope/{envelopeId}/audit-log", "Envelopes.ListAuditLog", "find-envelope-audit-logs"),
  http("POST", "/api/v1/documents/{id}/send", "Envelopes.Send", { auth: "api token", audience: "public", sources: [src("packages/api/v1/contract.ts", "sendDocument", 192)], note: "API v1 is deprecated but still served." }),
  rpc("trpc", "recipient.completeDocumentWithToken", "Signing.Complete", { auth: "recipient token", sources: [src("packages/trpc/server/recipient-router/router.ts", "completeDocumentWithToken", 590)] }),
  rpc("trpc", "recipient.rejectDocumentWithToken", "Signing.Reject", { auth: "recipient token", sources: [src("packages/trpc/server/recipient-router/router.ts", "rejectDocumentWithToken", 679)] }),
  rpc("trpc", "webhook.createWebhook", "Webhooks.CreateWebhook", { auth: "session", sources: [src("packages/trpc/server/webhook-router/router.ts", "createWebhook", 54)] }),
];
const apiModule = (endpoints = apiEndpoints) => module("Api", {
  purpose: "Every way in: the public API v2 (tRPC exposed as OpenAPI), the deprecated v1 REST API, and the app's own tRPC calls. Validates input and calls the contracts.",
  sources: [src("packages/trpc/server/"), src("packages/api/v1/"), src("apps/remix/server/router.ts")],
  note: "Rate limits and CSRF are applied per prefix in apps/remix/server/router.ts. Only the endpoints near the change are listed.",
  uses: ["Envelopes", "Signing", "Webhooks", "Accounts"],
  endpoints,
  signals: endpoints.filter((e) => e.path.startsWith("recipient.")).map((e) =>
    log(`${e.path} called`, e.name, ["requestId", "ipAddress", "userAgent", "documentId"],
      { sources: [src("packages/trpc/server/context.ts", "trpcLogger", 35)], note: "pino, through the per-request child logger. Never log the token or the input body." })),
  tests: endpoints.some((e) => e.path === "recipient.delegateDocumentWithToken")
    ? [test("a delegate gets the signing request and can sign", "e2e", "recipient.delegateDocumentWithToken",
      { note: "Playwright, next to rejected-recipient-advancement.spec.ts." })]
    : [],
});

// --- The change: delegation ------------------------------------------------------

const envelopesV2: Module = module("Envelopes", {
  purpose: envelopesV1.purpose,
  sources: envelopesSources,
  note: envelopesNote,
  entities: [
    envelopeFields.envelope,
    { ...envelopeFields.meta, fields: [...envelopeFields.meta.fields, { name: "allowDelegation", type: t.optional(t.boolean) }] },
    entity("Recipient", { ...envelopeFields.recipientShape, delegatedFromId: t.optional(t.int) },
      { sources: [src("packages/prisma/schema.prisma", "Recipient", 646)], note: recipientNote }),
    envelopeFields.field, envelopeFields.signature,
  ],
  aggregates: [aggregate("Envelope", ["DocumentMeta", "Recipient", "Field", "Signature"], [
    ...invariants.slice(0, 1),
    "A recipient's signingStatus moves from NOT_SIGNED to SIGNED, REJECTED or DELEGATED, never back.",
    ...invariants.slice(2),
    "Delegating creates a new recipient in the same signing position, moves the original's unfilled fields to it, and the original's token stops working.",
    "Only a SIGNER or APPROVER who has not acted can delegate, and only when the envelope allows it.",
  ])],
  repositories: envelopesV1.repositories,
  stores: [mainDb()],
  modules: [signingOrder, auditTrail, sealing],
  uses: envelopesV1.uses.map((u) => u.contract),
  ports: [jobsPort],
  signals: [rejectAudit, audit("recipient delegated", "Signing.Delegate", ["envelopeId", "fromRecipientId", "toRecipientId", "reason", "ipAddress", "userAgent"],
    { note: "A new DocumentAuditLog type, DOCUMENT_RECIPIENT_DELEGATED. The certificate should show who handed over to whom." })],
  tests: [
    rejectE2e,
    test("only a pending signer or approver can delegate, and only when allowed", "unit", ["Signing.Delegate", "Envelope"], { fakes: ["Jobs"] }),
    test("delegating moves unfilled fields and the old token stops working", "unit", ["Signing.Delegate", "Envelope"], { fakes: ["Jobs"] }),
    test("the delegate takes the original's place in the signing order", "unit", ["Signing.Delegate", "SigningOrder.NextPendingRecipients"], { fakes: ["Jobs"] }),
    test("delegating writes one audit entry and emits RecipientDelegated", "integration", ["Signing.Delegate", "Envelopes.RecipientDelegated"],
      { fakes: ["Jobs"], note: "Against a real database, like the other Prisma tests." }),
  ],
  provides: [
    envelopeContract({
      status: ["NOT_SIGNED", "SIGNED", "REJECTED", "DELEGATED"],
      recipientView: { id: t.int, email: t.string, name: t.string, role: t.ref("RecipientRole"), signingStatus: t.ref("SigningStatus"), delegatedFromId: t.optional(t.int) },
      settings: { signingOrder: t.ref("SigningOrderMode"), allowDictateNextSigner: t.boolean, allowDelegation: t.optional(t.boolean) },
      events: [...baseEvents, event("RecipientDelegated", { envelopeId: t.string, fromRecipientId: t.int, toRecipientId: t.int, reason: t.optional(t.string) })],
    }),
    signingContract({
      types: [record("DelegateTo", { email: t.string, name: t.string, reason: t.optional(t.string) })],
      ops: [command("Delegate", { token: t.string, to: t.ref("DelegateTo") }, t.int,
        ["NotFound", "Expired", "NotPending", "AlreadyActioned", "NotYourTurn", "DelegationNotAllowed", "AlreadyARecipient"])],
    }),
  ],
});
// The audit type list gains the new entry. It is a free-text column, so no migration.
envelopesV2.modules = [signingOrder, {
  ...auditTrail,
  provides: [{
    ...auditTrail.provides[0],
    types: [enumOf("AuditType", ["DOCUMENT_SENT", "DOCUMENT_OPENED", "DOCUMENT_RECIPIENT_COMPLETED", "DOCUMENT_RECIPIENT_REJECTED", "DOCUMENT_RECIPIENT_DELEGATED", "RECIPIENT_UPDATED", "DOCUMENT_COMPLETED"]), auditTrail.provides[0].types[1]],
  }],
}, sealing];

const emailsV2: Module = {
  ...emailsV1,
  uses: [{ contract: "Envelopes", subscribes: [...emailsV1.uses[0].subscribes, "RecipientDelegated"] }],
};

const doc: PlanDocument = {
  format: "plan-doc/1",
  title: "Signer delegation",
  intent: "Let a signer hand their signing over to someone else (an assistant, a colleague with signing authority). The sender should be told, and the audit log and certificate should show who delegated to whom.",
  mode: "plan",
  current: plan("documenso", [envelopesV1, emailsV1, webhooks(webhookEvents, webhookSubs), accounts, templates, apiModule()]),
  proposed: plan("documenso", [envelopesV2, emailsV2, webhooks([...webhookEvents, "RECIPIENT_DELEGATED"], [...webhookSubs, "RecipientDelegated"]), accounts, templates,
    apiModule([...apiEndpoints, rpc("trpc", "recipient.delegateDocumentWithToken", "Signing.Delegate", { auth: "recipient token" })])]),
  slices: [
    {
      name: "Delegation in the data",
      goal: "Add the DELEGATED status, the delegatedFromId link and the allowDelegation setting, with their migrations. Senders can switch the setting on; nothing reads it yet.",
      nodes: ["Envelopes/entity/Recipient", "Envelopes/entity/DocumentMeta", "Envelopes/contract/Envelopes/type/SigningStatus", "Envelopes/contract/Envelopes/type/EnvelopeSettings", "Envelopes/contract/Envelopes/type/RecipientView"],
      notes: "Adding DELEGATED to SigningStatus breaks exhaustive switches in the API schemas and the signing UI; find them in this slice.",
    },
    {
      name: "A signer can delegate",
      goal: "Signing.Delegate creates the new recipient, moves the fields, kills the old token, writes the audit entry and emits RecipientDelegated. The delegate gets the usual signing request.",
      nodes: ["Envelopes/contract/Signing/Delegate", "Envelopes/contract/Signing/type/DelegateTo", "Api/endpoint/recipient.delegateDocumentWithToken", "Envelopes/contract/Envelopes/RecipientDelegated", "Envelopes/AuditTrail/contract/AuditTrail/type/AuditType", "Envelopes/aggregate/Envelope"],
    },
    {
      name: "Everyone hears about it",
      goal: "The sender gets an email and teams can subscribe a webhook to RECIPIENT_DELEGATED.",
      nodes: ["Emails", "Webhooks", "Webhooks/contract/Webhooks/type/WebhookEvent", "Webhooks/entity/Webhook", "Webhooks/entity/WebhookCall"],
    },
  ],
  questions: [
    {
      text: "If the original signer had access auth (account login or 2FA), what does the delegate get?",
      node: "Envelopes/contract/Signing/Delegate",
      options: ["Same auth as the original", "No auth, sender can add it", "Block delegation for those signers"],
    },
    {
      text: "Can a delegate delegate again?",
      node: "Envelopes/aggregate/Envelope",
      options: ["No, one hop only", "Yes, any number of times"],
    },
    {
      text: "Should delegation default to on for teams that already allow dictating the next signer?",
      node: "Envelopes/entity/DocumentMeta",
      options: ["Off for everyone", "Follow allowDictateNextSigner"],
    },
    {
      text: "The delegation unit tests need to replace the jobs client. Pass it in, or mock the import like today?",
      node: "Envelopes/port/Jobs",
      options: ["Pass Jobs in to the new delegate function only", "vi.mock the jobs import in these tests", "Inject it everywhere (a separate change)"],
    },
  ],
  decisions: [
    {
      text: "Delegation adds a new recipient row and marks the original DELEGATED, rather than editing the original's name and email.",
      why: "Dictating the next signer edits in place (complete-document-with-token.ts:483), which is safe because that recipient was never sent a link. Here the original already holds a live link, and the certificate has to show both people, so the old row and token must stay as history.",
      node: "Envelopes/entity/Recipient",
    },
    {
      text: "Delegate lives on the Signing contract, authorised by the signer's token, not on the sender's Envelopes contract.",
      why: "It is the recipient who acts. A sender replacing a recipient is already covered by SetRecipients.",
      node: "Envelopes/contract/Signing",
    },
    {
      text: "Delegation is a tRPC call from the signing page only, not a public API v2 endpoint.",
      why: "Every other token-authorised action (complete, reject) is app-only too. A public endpoint would need its own auth story for API callers acting for a signer.",
      node: "Api/endpoint/recipient.delegateDocumentWithToken",
    },
    {
      text: "Emails and Webhooks learn about delegation through a RecipientDelegated event, as they do for rejection.",
      why: "Envelopes should not know which emails exist. In code this is still a direct job trigger, the same as rejection today.",
      node: "Envelopes/contract/Envelopes/RecipientDelegated",
    },
  ],
  glossary: [
    { term: "Envelope", meaning: "A document (or template) together with its files, recipients, fields and settings. The thing that gets sent.", node: "Envelopes/entity/Envelope" },
    { term: "Recipient", meaning: "Anyone the envelope goes to. Their role says what they do: sign, approve, view, assist or just get a copy (CC).", node: "Envelopes/entity/Recipient" },
    { term: "Token", meaning: "The secret in a recipient's signing link. It is their only credential: whoever has it can act as them.", node: "Envelopes/contract/Signing" },
    { term: "Field", meaning: "A box placed on a page for one recipient to fill: signature, date, text, checkbox.", node: "Envelopes/entity/Field" },
    { term: "Signing order", meaning: "PARALLEL lets everyone act at once; SEQUENTIAL makes recipients wait for their turn.", node: "Envelopes/SigningOrder" },
    { term: "Dictate next signer", meaning: "An existing option where a signer types in who signs after them. It edits that next recipient in place.", node: "Envelopes/entity/DocumentMeta" },
    { term: "Sealing", meaning: "Once everyone has acted, the signatures are burned into the PDF and the file is cryptographically signed.", node: "Envelopes/Sealing" },
    { term: "Audit log", meaning: "Every action on an envelope, with who did it. It is printed into the signing certificate.", node: "Envelopes/AuditTrail" },
    { term: "Distribute", meaning: "Sending a draft envelope out: it becomes PENDING and the first recipients get their links.", node: "Envelopes/contract/Envelopes/Send" },
  ],
  facts: {
    "Envelopes/entity/Recipient": [
      { label: "Files writing Recipient rows", value: 29, detail: "grep for (prisma|tx).recipient.(update|create|delete|upsert…), excluding e2e tests" },
    ],
    "Envelopes": [
      { label: "Files enqueueing email jobs", value: 22, detail: "grep for name: 'send. in lib/server-only, trpc and apps" },
      { label: "Files calling triggerWebhook", value: 17, detail: "grep, excluding e2e tests" },
    ],
  },
};

export default doc;
