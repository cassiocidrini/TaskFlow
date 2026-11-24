-- Módulo 14.5: chaves de idempotência do POST /tasks (ver o comentário do modelo no schema.prisma).
-- CreateTable
CREATE TABLE "idempotency_keys" (
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("user_id","key")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- Defesa no banco, além da validação do header (o Prisma não modela CHECK, então não vê como drift)
ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_key_length" CHECK (char_length("key") BETWEEN 1 AND 255);
