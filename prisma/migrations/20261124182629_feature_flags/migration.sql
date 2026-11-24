-- Módulo 14.6: feature flags e a auditoria das mudanças (ver os comentários dos modelos no schema.prisma).
-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout_percentage" INTEGER NOT NULL DEFAULT 0,
    "allow_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "platforms" "AppPlatform"[] DEFAULT ARRAY[]::"AppPlatform"[],
    "min_app_version" TEXT,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "feature_flag_changes" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "changed_by" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_flag_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feature_flag_changes_key_changed_at_idx" ON "feature_flag_changes"("key", "changed_at" DESC);

-- Defesa no banco, além da validação do comando (o Prisma não modela CHECK, então não vê como drift)
ALTER TABLE "feature_flags"
  ADD CONSTRAINT "feature_flags_rollout_range" CHECK ("rollout_percentage" BETWEEN 0 AND 100),
  -- kebab-case: é o nome que chega ao app em GET /me/features
  ADD CONSTRAINT "feature_flags_key_format" CHECK ("key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("key") <= 64),
  ADD CONSTRAINT "feature_flags_min_app_version_format"
    CHECK ("min_app_version" ~ '^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$');
