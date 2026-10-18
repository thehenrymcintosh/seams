# Planned change: shop v1 → shop v2

5 breaking, 3 migration, 5 additive, 8 internal.

## Payments

- `additive` new module: Collects money for an order and reports the outcome. Knows nothing about what was bought.

## Orders

- `breaking` Orders: OrderStatus gains value "AwaitingPayment" (exhaustive switches must handle it)
- `breaking` Orders: OrderStatus gains value "Paid" (exhaustive switches must handle it)
- `breaking` Orders: OrderStatus gains value "PaymentFailed" (exhaustive switches must handle it)
- `breaking` Orders: OrderStatus loses value "Placed"
- `breaking` Orders: CancelOrder: can now fail with AlreadyPaid
- `migration` Order: add column paymentId: uuid?
- `migration` Order.status: rows with "Placed" must be mapped to a new OrderStatus
- `migration` Order.status: database enum gains "AwaitingPayment", "Paid", "PaymentFailed"
- `additive` new endpoint GET /orders/{id}/payment
- `additive` new metric orders_placed_total
- `additive` new log orders.payment_failed
- `additive` Orders: new event OrderPaid
- `internal` Order: new invariant: Status only moves forward: AwaitingPayment, then Paid or PaymentFailed.
- `internal` new unit test: placing an order totals its lines
- `internal` new unit test: a captured payment marks the order paid
- `internal` new unit test: a paid order can't be cancelled
- `internal` new e2e test: checkout end to end
- `internal` now depends on Payments
- `internal` now reacts to Payments.PaymentCaptured
- `internal` now reacts to Payments.PaymentFailed
