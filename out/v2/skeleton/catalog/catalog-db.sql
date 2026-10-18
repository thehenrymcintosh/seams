-- Generated from the plan: Catalog / catalog db (postgres).

CREATE TABLE "products" (
  "id" uuid NOT NULL,
  "sku" text NOT NULL,
  "name" text NOT NULL,
  "price" numeric NOT NULL,
  "active" boolean NOT NULL,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "products_sku_idx" ON "products" ("sku");
CREATE INDEX "products_active_idx" ON "products" ("active");
