-- Generated from the plan: Orders / orders db (postgres).

CREATE TYPE "OrderStatus" AS ENUM ('AwaitingPayment', 'Paid', 'PaymentFailed', 'Cancelled');

CREATE TABLE "orders" (
  "id" uuid NOT NULL,
  "customerId" uuid NOT NULL,
  "status" "OrderStatus" NOT NULL,
  "total" numeric(12,2) NOT NULL,
  "placedAt" timestamptz NOT NULL,
  "paymentId" uuid,
  PRIMARY KEY ("id")
);
CREATE INDEX "orders_customerId_idx" ON "orders" ("customerId");

CREATE TABLE "order_lines" (
  "id" uuid NOT NULL,
  "orderId" uuid NOT NULL,
  "productId" uuid NOT NULL,
  "quantity" integer NOT NULL,
  "unitPrice" numeric NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "order_lines_orderId_idx" ON "order_lines" ("orderId");
