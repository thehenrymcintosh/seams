// Worked example, version 1: a small shop with a catalog and orders.

import {
  aggregate, command, contract, entity, enumOf, event, findBy, get, module, plan, query, record, repo, save, t,
} from "../src/dsl.ts";

export const catalog = module("Catalog", {
  purpose: "Owns what can be sold and at what price.",
  entities: [
    entity("Product", {
      id: t.uuid, sku: t.string, name: t.string, price: t.decimal, active: t.boolean,
    }, { indexes: [{ fields: ["sku"], unique: true }, { fields: ["active"] }] }),
  ],
  repositories: [repo("Product", [get, findBy("sku"), findBy("active"), save])],
  provides: [
    contract("Catalog", {
      types: [record("ProductSummary", { id: t.uuid, name: t.string, price: t.decimal })],
      operations: [
        query("GetProduct", { id: t.uuid }, t.ref("ProductSummary"), ["NotFound"]),
        query("ListActive", {}, t.list(t.ref("ProductSummary"))),
      ],
      events: [event("ProductPriceChanged", { productId: t.uuid, price: t.decimal })],
    }),
  ],
});

const ordersContract = contract("Orders", {
  types: [
    enumOf("OrderStatus", ["Placed", "Cancelled"]),
    record("LineInput", { productId: t.uuid, quantity: t.int }),
    record("OrderLineView", { product: t.ref("Catalog.ProductSummary"), quantity: t.int, unitPrice: t.decimal }),
    record("OrderView", {
      id: t.uuid, status: t.ref("OrderStatus"), total: t.decimal, lines: t.list(t.ref("OrderLineView")),
    }),
  ],
  operations: [
    command("PlaceOrder", { customerId: t.uuid, lines: t.list(t.ref("LineInput")) }, t.ref("OrderView"),
      ["EmptyOrder", "UnknownProduct"]),
    command("CancelOrder", { id: t.uuid }, null, ["NotFound", "AlreadyCancelled"]),
    query("GetOrder", { id: t.uuid }, t.ref("OrderView"), ["NotFound"]),
    query("ListForCustomer", { customerId: t.uuid }, t.list(t.ref("OrderView"))),
  ],
  events: [event("OrderPlaced", { orderId: t.uuid, total: t.decimal })],
});

export const orders = module("Orders", {
  purpose: "Turns a customer's basket into an order and tracks it to completion.",
  entities: [
    entity("Order", {
      id: t.uuid, customerId: t.uuid, status: t.ref("OrderStatus"), total: t.decimal, placedAt: t.datetime,
    }, { indexes: [{ fields: ["customerId"] }] }),
    entity("OrderLine", {
      id: t.uuid, orderId: t.uuid, productId: t.uuid, quantity: t.int, unitPrice: t.decimal,
    }, { indexes: [{ fields: ["orderId"] }], doc: "Price is copied at order time; Catalog prices may change later." }),
  ],
  aggregates: [aggregate("Order", ["OrderLine"], ["Total equals the sum of its lines.", "Lines cannot change once the order is placed."])],
  repositories: [repo("Order", [get, findBy("customerId"), save])],
  provides: [ordersContract],
  uses: ["Catalog"],
});

export default plan("shop v1", [catalog, orders]);
