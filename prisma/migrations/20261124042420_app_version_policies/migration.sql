-- CreateEnum
CREATE TYPE "AppPlatform" AS ENUM ('ios', 'android', 'web');

-- CreateTable
CREATE TABLE "app_version_policies" (
    "platform" "AppPlatform" NOT NULL,
    "min_version" TEXT,
    "recommended_version" TEXT,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_version_policies_pkey" PRIMARY KEY ("platform")
);

-- CreateTable
CREATE TABLE "app_version_policy_changes" (
    "id" BIGSERIAL NOT NULL,
    "platform" "AppPlatform" NOT NULL,
    "previous_min_version" TEXT,
    "previous_recommended_version" TEXT,
    "min_version" TEXT,
    "recommended_version" TEXT,
    "changed_by" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_version_policy_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_version_policy_changes_platform_changed_at_idx" ON "app_version_policy_changes"("platform", "changed_at" DESC);

-- Defesa no banco, além da validação do comando (o Prisma não modela CHECK, então ele não vê isto como drift).
-- Versão de loja: MAJOR.MINOR.PATCH, até 4 dígitos por parte, sem zero à esquerda (o mesmo de `app-version.ts`).
ALTER TABLE "app_version_policies"
  ADD CONSTRAINT "app_version_policies_min_version_format"
    CHECK ("min_version" ~ '^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'),
  ADD CONSTRAINT "app_version_policies_recommended_version_format"
    CHECK ("recommended_version" ~ '^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'),
  -- Mínima acima da recomendada não faz sentido (o "recomendado" nunca apareceria). Comparação NUMÉRICA, como array
  -- de inteiros: como texto, '1.10.0' < '1.9.0'
  ADD CONSTRAINT "app_version_policies_min_not_above_recommended"
    CHECK (
      "min_version" IS NULL OR "recommended_version" IS NULL OR
      string_to_array("min_version", '.')::int[] <= string_to_array("recommended_version", '.')::int[]
    ),
  -- Uma linha sem nenhuma das duas versões não é política: o comando apaga em vez de gravar vazio
  ADD CONSTRAINT "app_version_policies_has_a_version"
    CHECK ("min_version" IS NOT NULL OR "recommended_version" IS NOT NULL);
