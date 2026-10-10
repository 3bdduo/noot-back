-- Optional performance indexes that Prisma's schema language cannot express.
-- Run ONCE, after the first `prisma migrate deploy`, in the Supabase / Neon SQL editor (or psql):
--   psql "$DIRECT_URL" -f prisma/sql/extra-indexes.sql
-- Everything is idempotent (IF NOT EXISTS) and safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Shop search: `searchText contains <word>` becomes an index scan instead of a sequential scan.
CREATE INDEX IF NOT EXISTS "Product_searchText_trgm_idx" ON "Product" USING gin ("searchText" gin_trgm_ops);

-- Admin order search by number / email / phone fragments.
CREATE INDEX IF NOT EXISTS "Order_orderNumber_trgm_idx" ON "Order" USING gin ("orderNumber" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Order_contactEmail_trgm_idx" ON "Order" USING gin ("contactEmail" gin_trgm_ops);

-- COD abuse check: pending COD orders per phone.
CREATE INDEX IF NOT EXISTS "Order_cod_pending_phone_idx" ON "Order" ("contactPhone") WHERE "status" = 'COD_PENDING';

-- Cron: orders whose reservation window ended / reservations to release.
CREATE INDEX IF NOT EXISTS "Order_reservation_due_idx" ON "Order" ("reservationExpiresAt") WHERE "status" IN ('PENDING_PAYMENT', 'COD_PENDING');
CREATE INDEX IF NOT EXISTS "InventoryReservation_active_expiry_idx" ON "InventoryReservation" ("expiresAt") WHERE "status" = 'ACTIVE';

-- Customization review queue.
CREATE INDEX IF NOT EXISTS "OrderItem_pending_review_idx" ON "OrderItem" ("createdAt") WHERE "customizationReviewStatus" = 'PENDING_REVIEW';

-- Pending e-mails for the retry job.
CREATE INDEX IF NOT EXISTS "Notification_pending_email_idx" ON "Notification" ("createdAt") WHERE "channel" = 'EMAIL' AND "status" = 'PENDING';
