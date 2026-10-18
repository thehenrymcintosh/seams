# shop v2

```mermaid
flowchart LR
  subgraph Catalog["Catalog"]
    direction TB
    Catalog_c{{"Catalog contract"}}
    Catalog_Product[("Product")]
  end
  subgraph Orders["Orders"]
    direction TB
    Orders_c{{"Orders contract"}}
    Orders_Order[("Order")]
    Orders_OrderLine[("OrderLine")]
  end
  subgraph Payments["Payments"]
    direction TB
    Payments_c{{"Payments contract"}}
    Payments_Payment[("Payment")]
  end
  subgraph Gateway["Gateway"]
    direction TB
    Gateway_c{{"Gateway contract"}}
  end
  Orders -->|calls| Catalog_c
  Orders -->|calls| Payments_c
  Payments_c -.->|PaymentCaptured| Orders
  Payments_c -.->|PaymentFailed| Orders
  Payments -->|calls| Gateway_c
```

## Catalog

Owns what can be sold and at what price.

**Depends on:** nothing

### Data

```mermaid
erDiagram
  Product {
    uuid id PK
    string sku
    string name
    decimal price
    boolean active
  }
```

- `ProductRepository`: get by key, find by sku, find by active, save

### Contract `Catalog`

- type **ProductSummary** { id: uuid, name: string, price: decimal }
- query `GetProduct(id: uuid) → ProductSummary` · fails with NotFound
- query `ListActive() → ProductSummary[]`
- event **ProductPriceChanged** { productId: uuid, price: decimal }

## Orders

Turns a customer's basket into an order and tracks it to completion.

**Depends on:** Catalog, Payments

### Data

```mermaid
erDiagram
  Order {
    uuid id PK
    uuid customerId
    OrderStatus status
    decimal total
    datetime placedAt
    uuid_ paymentId
  }
  OrderLine {
    uuid id PK
    uuid orderId
    uuid productId
    int quantity
    decimal unitPrice
  }
```

- `OrderRepository`: get by key, find by customerId, save

### Contract `Orders`

- type **OrderStatus** = `AwaitingPayment` \| `Paid` \| `PaymentFailed` \| `Cancelled`
- type **LineInput** { productId: uuid, quantity: int }
- type **OrderLineView** { product: Catalog.ProductSummary, quantity: int, unitPrice: decimal }
- type **OrderView** { id: uuid, status: OrderStatus, total: decimal, lines: OrderLineView[] }
- command `PlaceOrder(customerId: uuid, lines: LineInput[]) → OrderView` · fails with EmptyOrder, UnknownProduct
- command `CancelOrder(id: uuid) → void` · fails with NotFound, AlreadyCancelled, AlreadyPaid
- query `GetOrder(id: uuid) → OrderView` · fails with NotFound
- query `ListForCustomer(customerId: uuid) → OrderView[]`
- event **OrderPlaced** { orderId: uuid, total: decimal }
- event **OrderPaid** { orderId: uuid }

### Uses

- `Catalog`
- `Payments`, reacts to PaymentCaptured, PaymentFailed

## Payments

Collects money for an order and reports the outcome. Knows nothing about what was bought.

**Depends on:** Gateway

### Data

```mermaid
erDiagram
  Payment {
    uuid id PK
    uuid orderId
    decimal amount
    PaymentStatus status
    string_ providerRef
    datetime createdAt
  }
```

- `PaymentRepository`: get by key, find by orderId, save

### Contract `Payments`

- type **PaymentStatus** = `Pending` \| `Captured` \| `Failed`
- command `StartPayment(orderId: uuid, amount: decimal) → uuid` · fails with AlreadyPaid
- query `GetStatus(orderId: uuid) → PaymentStatus` · fails with NotFound
- event **PaymentCaptured** { paymentId: uuid, orderId: uuid }
- event **PaymentFailed** { orderId: uuid, reason: string }

### Uses

- `Gateway`

## Gateway

Talks to the card provider. One implementation per provider; nothing outside Payments sees it.

**Depends on:** nothing

### Contract `Gateway`

- command `Charge(amount: decimal, reference: string) → string` · fails with Declined, ProviderDown
