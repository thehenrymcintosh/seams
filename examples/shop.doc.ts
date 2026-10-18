// The worked example as a plan document: v1 is the current tree, v2 the
// proposal, with two stubs the agent named but did not need to map.

import type { Module } from "../src/ast.ts";
import type { PlanDocument } from "../src/doc.ts";
import { plan, stub, subscribe } from "../src/dsl.ts";
import { catalog, orders as ordersV1 } from "./shop.v1.ts";
import { orders as ordersV2, payments } from "./shop.v2.ts";

const customers = stub("Customers", "Accounts, addresses and sign-in.", ["Customers"], [{ path: "src/customers/" }]);
const notifications: Module = {
  ...stub("Notifications", "Emails and push messages to customers.", [], [{ path: "src/notify/" }]),
  uses: [subscribe("Orders", "OrderPlaced")],
};
const withCustomers = (m: Module): Module => ({ ...m, uses: [...m.uses, { contract: "Customers", subscribes: [] }] });

const doc: PlanDocument = {
  format: "plan-doc/1",
  title: "Take payment at checkout",
  intent: "We're adding card payments to checkout. Orders should only count as placed once the money is captured.",
  mode: "plan",
  current: plan("shop", [withCustomers(ordersV1), catalog, customers, notifications]),
  proposed: plan("shop", [withCustomers(ordersV2), catalog, payments, customers, notifications]),
  slices: [
    {
      name: "Payments on its own",
      goal: "Ship the Payments module with its table and contract. Nothing calls it yet, so it can be tested against the provider in isolation.",
      nodes: ["Payments"],
    },
    {
      name: "Orders takes payment",
      goal: "PlaceOrder starts a payment and the order follows the payment events. Includes the status migration.",
      nodes: ["Orders"],
      notes: "Existing Placed orders become Paid: they were taken before payments existed.",
    },
  ],
  questions: [
    {
      text: "When a payment fails, should the order be cancelled or left open for the customer to retry?",
      node: "Orders/contract/Orders",
      options: ["Cancel", "Keep open for 24h"],
    },
  ],
  decisions: [
    {
      text: "Payments stores the order id but never calls Orders.",
      why: "Orders depends on Payments, not the other way round. That avoids a cycle and keeps Payments reusable for subscriptions later.",
      node: "Payments",
    },
  ],
  facts: {
    "Orders/contract/Orders": [
      { label: "Call sites", value: 9, detail: "example value; slice 3 reads these from the code" },
    ],
    "Orders": [
      { label: "Most complex function", value: "placeOrder (17)", detail: "example value" },
    ],
  },
};

export default doc;
