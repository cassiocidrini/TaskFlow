import type { AppPlatform } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  compareAppVersions,
  parseAppVersion,
} from '../common/client/app-version';

/** Pedido recusado por regra (versão inválida, mínima acima da recomendada): o comando sai com a mensagem, sem stack. */
export class VersionPolicyRefusedError extends Error {}

export interface PolicyVersions {
  minVersion: string | null;
  recommendedVersion: string | null;
}

export interface PolicyChangeRequest {
  platform: AppPlatform;
  /** `undefined` = mantém; `null` = remove; texto = nova versão. Idem para a recomendada. */
  minVersion?: string | null;
  recommendedVersion?: string | null;
  requestedBy: string;
  dryRun: boolean;
}

export interface PolicyChangeReport {
  platform: AppPlatform;
  /** `null` = a plataforma não tinha (ou deixa de ter) política. */
  before: PolicyVersions | null;
  after: PolicyVersions | null;
  changed: boolean;
}

/** Serializa as mudanças de política: duas pessoas rodando o comando ao mesmo tempo não se atropelam na auditoria. */
const POLICY_LOCK = 'taskflow.app-version-policy';

/**
 * Lê e muda a política de versão do app (Módulo 14.2), com auditoria. Usado pelo comando `npm run app-version`.
 *
 * Por que um comando, e não um endpoint de admin: a API não tem papéis de usuário (todo usuário é dono dos próprios
 * projetos), e criar autorização de administrador só para isto abriria mais superfície do que resolve. Quem roda o
 * comando já tem acesso ao banco, que é o controle de acesso real.
 *
 * Numa transação, sob um advisory lock: lê o valor atual, valida o resultado (formato e mínima ≤ recomendada, as
 * mesmas regras das `CHECK` do banco, aqui com mensagem legível), grava a política (ou apaga, se nenhuma das versões
 * sobrar) e registra antes/depois em `app_version_policy_changes`.
 */
export class AppVersionPolicyAdmin {
  constructor(private readonly prisma: PrismaService) {}

  async show(): Promise<
    Array<
      PolicyVersions & {
        platform: AppPlatform;
        updatedBy: string;
        updatedAt: Date;
      }
    >
  > {
    return this.prisma.appVersionPolicy.findMany({
      orderBy: { platform: 'asc' },
    });
  }

  async change(request: PolicyChangeRequest): Promise<PolicyChangeReport> {
    for (const value of [request.minVersion, request.recommendedVersion]) {
      if (typeof value === 'string' && !parseAppVersion(value)) {
        throw new VersionPolicyRefusedError(
          `versão inválida: "${value}" (formato MAJOR.MINOR.PATCH, ex.: 2.10.0)`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${POLICY_LOCK}))`;
      const current = await tx.appVersionPolicy.findUnique({
        where: { platform: request.platform },
      });
      const before: PolicyVersions | null = current
        ? {
            minVersion: current.minVersion,
            recommendedVersion: current.recommendedVersion,
          }
        : null;
      const merged: PolicyVersions = {
        minVersion:
          request.minVersion === undefined
            ? (before?.minVersion ?? null)
            : request.minVersion,
        recommendedVersion:
          request.recommendedVersion === undefined
            ? (before?.recommendedVersion ?? null)
            : request.recommendedVersion,
      };
      assertConsistent(merged);
      const after =
        merged.minVersion === null && merged.recommendedVersion === null
          ? null
          : merged;
      const changed = !sameVersions(before, after);
      const report = { platform: request.platform, before, after, changed };
      if (!changed || request.dryRun) return report;

      if (after) {
        await tx.appVersionPolicy.upsert({
          where: { platform: request.platform },
          create: {
            platform: request.platform,
            ...after,
            updatedBy: request.requestedBy,
          },
          update: {
            ...after,
            updatedBy: request.requestedBy,
            updatedAt: new Date(),
          },
        });
      } else {
        await tx.appVersionPolicy.delete({
          where: { platform: request.platform },
        });
      }
      await tx.appVersionPolicyChange.create({
        data: {
          platform: request.platform,
          previousMinVersion: before?.minVersion ?? null,
          previousRecommendedVersion: before?.recommendedVersion ?? null,
          minVersion: after?.minVersion ?? null,
          recommendedVersion: after?.recommendedVersion ?? null,
          changedBy: request.requestedBy,
        },
      });
      return report;
    });
  }
}

function assertConsistent(policy: PolicyVersions): void {
  const min = parseAppVersion(policy.minVersion);
  const recommended = parseAppVersion(policy.recommendedVersion);
  if (min && recommended && compareAppVersions(min, recommended) > 0) {
    throw new VersionPolicyRefusedError(
      `a mínima (${policy.minVersion}) não pode ficar acima da recomendada (${policy.recommendedVersion}): o aviso de "recomendada" nunca apareceria`,
    );
  }
}

function sameVersions(
  a: PolicyVersions | null,
  b: PolicyVersions | null,
): boolean {
  return (
    a?.minVersion === b?.minVersion &&
    a?.recommendedVersion === b?.recommendedVersion
  );
}

export function describe(policy: PolicyVersions | null): string {
  if (!policy) return 'sem política';
  return `mínima ${policy.minVersion ?? '—'}, recomendada ${policy.recommendedVersion ?? '—'}`;
}
