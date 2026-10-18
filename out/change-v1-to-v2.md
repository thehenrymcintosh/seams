# Planned change: shop v1 → shop v2

5 breaking, 3 migration, 2 additive, 4 internal.

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
- `additive` Orders: new event OrderPaid
- `internal` Order: new invariant: Status only moves forward: AwaitingPayment, then Paid or PaymentFailed.
- `internal` now depends on Payments
- `internal` now reacts to Payments.PaymentCaptured
- `internal` now reacts to Payments.PaymentFailed
