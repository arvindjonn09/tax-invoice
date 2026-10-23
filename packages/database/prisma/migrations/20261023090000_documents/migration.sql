BEGIN;

-- #34 Private documents (receipts, photos, tax invoices). The bytes live in
-- private S3-compatible storage under a random key; this row is the only way
-- to reach them, and only through an authorised, short-lived signed link.

-- CreateEnum
CREATE TYPE "document_kind" AS ENUM ('receipt', 'photo', 'tax_invoice', 'other');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "kind" "document_kind" NOT NULL,
    -- Random, server-generated; never derived from user input.
    "object_key" VARCHAR(200) NOT NULL,
    -- Display name only (sanitised); never used as a storage path.
    "file_name" VARCHAR(200) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "documents_object_key_format" CHECK ("object_key" ~ '^documents/[0-9a-f-]{36}/[0-9a-f]{64}$'),
    CONSTRAINT "documents_size_bounds" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760),
    CONSTRAINT "documents_content_type_allowed" CHECK ("content_type" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic')),
    CONSTRAINT "documents_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_object_key_key" ON "documents"("object_key");
CREATE UNIQUE INDEX "documents_company_id_id_key" ON "documents"("company_id", "id");
CREATE INDEX "documents_company_id_created_by_idx" ON "documents"("company_id", "created_by");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT;
