// A deliberately tangled variant of v2, to show what the checker catches.
// Payments "just needs" the order total, so it reaches into Orders' table,
// hands an Orders entity back through its contract, and calls Orders, which
// already calls Payments.

import { command, contract, entity, event, findBy, get, module, plan, repo, t } from "../src/dsl.ts";
import { catalog } from "./shop.v1.ts";
import { orders, payments as realPayments } from "./shop.v2.ts";

const payments = module("Payments", {
  purpose: "Collects money for an order.",
  entities: [
    entity("Payment", { id: t.uuid, orderId: t.uuid, amount: t.decimal }),
  ],
  repositories: [
    repo("Payment", [get, findBy("orderId")]),
    repo("Order", [get]),
  ],
  provides: [
    contract("Payments", {
      operations: [
        command("StartPayment", { orderId: t.uuid }, t.ref("Order"), ["AlreadyPaid"]),
      ],
      events: [
        event("PaymentCaptured", { paymentId: t.uuid, orderId: t.uuid }),
        event("PaymentFailed", { orderId: t.uuid, reason: t.string }),
      ],
    }),
  ],
  uses: ["Orders"],
});

// Orders also skips Payments and charges the card through its internal
// Gateway, and keeps a separate repository for its order lines.
const ordersTangled = {
  ...orders,
  uses: [...orders.uses, { contract: "Gateway", subscribes: [] }],
  repositories: [...orders.repositories, repo("OrderLine", [findBy("orderId")])],
};
const paymentsWithGateway = { ...payments, modules: realPayments.modules };

export default plan("shop v2 (tangled)", [catalog, ordersTangled, paymentsWithGateway]);
