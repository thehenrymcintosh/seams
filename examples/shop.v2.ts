// Worked example, version 2: the planned change. Orders now take payment
// through a new Payments module. Diff this against v1 to review the change.

import {
  aggregate, command, contract, entity, enumOf, event, findBy, get, module, plan, query, record, repo, save, subscribe, t,
} from "../src/dsl.ts";
import { catalog } from "./shop.v1.ts";

export const payments = module("Payments", {
  purpose: "Collects money for an order and reports the outcome. Knows nothing about what was bought.",
  entities: [
    entity("Payment", {
      id: t.uuid, orderId: t.uuid, amount: t.decimal, status: t.ref("PaymentStatus"),
      providerRef: t.optional(t.string), createdAt: t.datetime,
    }, { indexes: [{ fields: ["orderId"] }] }),
  ],
  repositories: [repo("Payment", [get, findBy("orderId"), save])],
  modules: [
    module("Gateway", {
      purpose: "Talks to the card provider. One implementation per provider; nothing outside Payments sees it.",
      provides: [
        contract("Gateway", {
          operations: [command("Charge", { amount: t.decimal, reference: t.string }, t.string, ["Declined", "ProviderDown"])],
        }),
      ],
    }),
  ],
  uses: ["Gateway"],
  provides: [
    contract("Payments", {
      types: [enumOf("PaymentStatus", ["Pending", "Captured", "Failed"])],
      operations: [
        command("StartPayment", { orderId: t.uuid, amount: t.decimal }, t.uuid, ["AlreadyPaid"]),
        query("GetStatus", { orderId: t.uuid }, t.ref("PaymentStatus"), ["NotFound"]),
      ],
      events: [
        event("PaymentCaptured", { paymentId: t.uuid, orderId: t.uuid }),
        event("PaymentFailed", { orderId: t.uuid, reason: t.string }),
      ],
    }),
  ],
});

export const orders = module("Orders", {
  purpose: "Turns a customer's basket into an order and tracks it to completion.",
  entities: [
    entity("Order", {
      id: t.uuid, customerId: t.uuid, status: t.ref("OrderStatus"), total: t.decimal, placedAt: t.datetime,
      paymentId: t.optional(t.uuid),
    }, { indexes: [{ fields: ["customerId"] }] }),
    entity("OrderLine", {
      id: t.uuid, orderId: t.uuid, productId: t.uuid, quantity: t.int, unitPrice: t.decimal,
    }, { indexes: [{ fields: ["orderId"] }], doc: "Price is copied at order time; Catalog prices may change later." }),
  ],
  aggregates: [aggregate("Order", ["OrderLine"], ["Total equals the sum of its lines.", "Lines cannot change once the order is placed.", "Status only moves forward: AwaitingPayment, then Paid or PaymentFailed."])],
  repositories: [repo("Order", [get, findBy("customerId"), save])],
  provides: [
    contract("Orders", {
      types: [
        enumOf("OrderStatus", ["AwaitingPayment", "Paid", "PaymentFailed", "Cancelled"]),
        record("LineInput", { productId: t.uuid, quantity: t.int }),
        record("OrderLineView", { product: t.ref("Catalog.ProductSummary"), quantity: t.int, unitPrice: t.decimal }),
        record("OrderView", {
          id: t.uuid, status: t.ref("OrderStatus"), total: t.decimal, lines: t.list(t.ref("OrderLineView")),
        }),
      ],
      operations: [
        command("PlaceOrder", { customerId: t.uuid, lines: t.list(t.ref("LineInput")) }, t.ref("OrderView"),
          ["EmptyOrder", "UnknownProduct"]),
        command("CancelOrder", { id: t.uuid }, null, ["NotFound", "AlreadyCancelled", "AlreadyPaid"]),
        query("GetOrder", { id: t.uuid }, t.ref("OrderView"), ["NotFound"]),
        query("ListForCustomer", { customerId: t.uuid }, t.list(t.ref("OrderView"))),
      ],
      events: [
        event("OrderPlaced", { orderId: t.uuid, total: t.decimal }),
        event("OrderPaid", { orderId: t.uuid }),
      ],
    }),
  ],
  uses: ["Catalog", subscribe("Payments", "PaymentCaptured", "PaymentFailed")],
});

export default plan("shop v2", [catalog, orders, payments]);
