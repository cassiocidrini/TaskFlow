import type { AppPlatform, FeatureFlag, Prisma } from '@prisma/client';
import { parseAppVersion } from '../../../common/client/app-version';
import { PLATFORMS } from '../../../common/client/client-info';
import type { PrismaService } from '../../../prisma/prisma.service';

/** Pedido recusado por regra (porcentagem fora de 0–100, versão inválida…): o comando sai com a mensagem, sem stack. */
export class FeatureFlagRefusedError extends Error {}

/** O que o comando pode mudar; `undefined` = mantém. */
export interface FeatureFlagChangeRequest {
  key: string;
  description?: string;
  /** `false` = kill switch: desliga para todos. */
  enabled?: boolean;
  rolloutPercentage?: number;
  /** `[]` = limpa a lista. */
  allowUserIds?: string[];
  /** `[]` = todas as plataformas. */
  platforms?: string[];
  /** `null` = qualquer versão. */
  minAppVersion?: string | null;
  requestedBy: string;
  dryRun: boolean;
}

export type FlagState = Pick<
  FeatureFlag,
  | 'description'
  | 'enabled'
  | 'rolloutPercentage'
  | 'allowUserIds'
  | 'platforms'
  | 'minAppVersion'
>;

export interface FeatureFlagChangeReport {
  key: string;
  before: FlagState | null;
  after: FlagState;
  changed: boolean;
}

const KEY_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Serializa as mudanças: duas pessoas mexendo em flags ao mesmo tempo não se atropelam na auditoria. */
const FLAGS_LOCK = 'taskflow.feature-flags';

/**
 * Cria e muda feature flags, com auditoria (Módulo 14.6). Usado pelo comando `npm run feature-flag`.
 *
 * Um comando, e não um endpoint de admin, pelo mesmo motivo da versão mínima (14.2): a API não tem papéis de usuário,
 * e quem roda o comando já tem acesso ao banco, que é o controle de acesso real. Valida com mensagem legível (as
 * mesmas regras viram CHECK no banco), grava numa transação sob advisory lock e registra antes/depois em
 * `feature_flag_changes`. Flag nova nasce DESLIGADA e com 0%: ligar é sempre um passo explícito.
 */
export class FeatureFlagAdmin {
  constructor(private readonly prisma: PrismaService) {}

  async show(): Promise<FeatureFlag[]> {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async change(
    request: FeatureFlagChangeRequest,
  ): Promise<FeatureFlagChangeReport> {
    validate(request);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FLAGS_LOCK}))`;
      const current = await tx.featureFlag.findUnique({
        where: { key: request.key },
      });
      if (!current && request.description === undefined) {
        throw new FeatureFlagRefusedError(
          `a flag "${request.key}" não existe: para criá-la, informe --description (ela nasce desligada e com 0%)`,
        );
      }
      const before = current ? stateOf(current) : null;
      const after: FlagState = {
        description: request.description ?? current!.description,
        enabled: request.enabled ?? before?.enabled ?? false,
        rolloutPercentage:
          request.rolloutPercentage ?? before?.rolloutPercentage ?? 0,
        allowUserIds: request.allowUserIds ?? before?.allowUserIds ?? [],
        platforms:
          (request.platforms as AppPlatform[] | undefined) ??
          before?.platforms ??
          [],
        minAppVersion:
          request.minAppVersion === undefined
            ? (before?.minAppVersion ?? null)
            : request.minAppVersion,
      };
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      const report = { key: request.key, before, after, changed };
      if (!changed || request.dryRun) return report;

      await tx.featureFlag.upsert({
        where: { key: request.key },
        create: { key: request.key, ...after, updatedBy: request.requestedBy },
        update: {
          ...after,
          updatedBy: request.requestedBy,
          updatedAt: new Date(),
        },
      });
      await tx.featureFlagChange.create({
        data: {
          key: request.key,
          before: (before ?? undefined) as Prisma.InputJsonValue | undefined,
          after: after as unknown as Prisma.InputJsonValue,
          changedBy: request.requestedBy,
        },
      });
      return report;
    });
  }
}

function validate(request: FeatureFlagChangeRequest): void {
  if (!KEY_FORMAT.test(request.key) || request.key.length > 64) {
    throw new FeatureFlagRefusedError(
      `chave inválida: "${request.key}" (kebab-case, até 64 caracteres, ex.: task-list-with-stats)`,
    );
  }
  const rollout = request.rolloutPercentage;
  if (
    rollout !== undefined &&
    (!Number.isInteger(rollout) || rollout < 0 || rollout > 100)
  ) {
    throw new FeatureFlagRefusedError(
      `--rollout precisa ser um inteiro de 0 a 100 (recebido: ${rollout})`,
    );
  }
  const invalidPlatform = request.platforms?.find(
    (p) => !PLATFORMS.some((known) => known === p),
  );
  if (invalidPlatform) {
    throw new FeatureFlagRefusedError(
      `plataforma inválida: "${invalidPlatform}" (use ${PLATFORMS.join(', ')})`,
    );
  }
  if (
    typeof request.minAppVersion === 'string' &&
    !parseAppVersion(request.minAppVersion)
  ) {
    throw new FeatureFlagRefusedError(
      `versão inválida: "${request.minAppVersion}" (formato MAJOR.MINOR.PATCH, ex.: 2.15.0)`,
    );
  }
}

function stateOf(flag: FeatureFlag): FlagState {
  return {
    description: flag.description,
    enabled: flag.enabled,
    rolloutPercentage: flag.rolloutPercentage,
    allowUserIds: flag.allowUserIds,
    platforms: flag.platforms,
    minAppVersion: flag.minAppVersion,
  };
}

/** Uma linha legível da regra, para o log do comando. */
export function describeFlag(state: FlagState | null): string {
  if (!state) return 'não existia';
  const parts = [
    state.enabled ? 'LIGADA' : 'DESLIGADA (kill switch)',
    `${state.rolloutPercentage}%`,
    state.allowUserIds.length
      ? `${state.allowUserIds.length} usuário(s) na lista`
      : null,
    state.platforms.length ? `só ${state.platforms.join('/')}` : null,
    state.minAppVersion ? `app ≥ ${state.minAppVersion}` : null,
  ];
  return parts.filter(Boolean).join(', ');
}
