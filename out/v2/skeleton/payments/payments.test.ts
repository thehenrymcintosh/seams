// Generated once from the plan: the tests it calls for.
import { test } from "node:test";

test("a second payment for the same order is refused", { todo: "unit; covers Payments.StartPayment; fakes Gateway, Clock" }, () => {});
test("a decline publishes PaymentFailed", { todo: "unit; covers Payments.StartPayment, Payments.PaymentFailed; fakes Gateway, Clock" }, () => {});
test("payments are found by order through byOrder", { todo: "integration; covers Payments.GetStatus" }, () => {});
