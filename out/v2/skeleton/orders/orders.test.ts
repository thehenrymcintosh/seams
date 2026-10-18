// Generated once from the plan: the tests it calls for.
import { test } from "node:test";

test("a captured payment marks the order paid", { todo: "unit; covers Payments.PaymentCaptured, Order; fakes Payments" }, () => {});
test("a paid order can't be cancelled", { todo: "unit; covers Orders.CancelOrder" }, () => {});
test("checkout end to end", { todo: "e2e; covers POST /orders, GET /orders/{id}/payment" }, () => {});
