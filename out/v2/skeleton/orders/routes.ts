// Generated from the plan. Endpoints only parse, authorise and call; no logic here.
import type * as Orders from "./Orders.contract.ts";
import type * as Payments from "../payments/Payments.contract.ts";

export function routes(api: { orders: Orders.OrdersApi; payments: Payments.PaymentsApi }) {
  return [
    { method: "POST", path: "/orders", auth: "customer session", audience: "public", calls: [api.orders.placeOrder] },
    { method: "GET", path: "/orders/{id}", auth: "customer session", audience: "public", calls: [api.orders.getOrder] },
    { method: "POST", path: "/orders/{id}/cancel", auth: "customer session", audience: "public", calls: [api.orders.cancelOrder] },
    { method: "GET", path: "/customers/{customerId}/orders", auth: "customer session", audience: "public", calls: [api.orders.listForCustomer] },
    { method: "GET", path: "/orders/{id}/payment", auth: "customer session", audience: "public", calls: [api.payments.getStatus] },
  ] as const;
}
