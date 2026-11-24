import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { parseAppVersion } from './app-version';
import type { Platform } from './client-info';
import type { VersionPolicy } from './version-policy';

type Policies = ReadonlyMap<Platform, VersionPolicy>;

/**
 * Lê a política de versão (tabela `app_version_policies`, Módulo 14.2) com cache em memória.
 *
 * **Por que cache:** sem ele, toda requisição faria uma query a mais para ler um valor que muda uma vez por mês. Com
 * ele, uma mudança feita pelo `npm run app-version` vale em todas as réplicas em até `APP_VERSION_POLICY_CACHE_TTL_MS`
 * (30 s por padrão): é o trade-off entre consistência e custo, explícito numa variável. Sem deploy, que é o que
 * importa para bloquear uma versão quebrada.
 *
 * **Uma leitura por vez:** quando o cache vence, as requisições que chegam juntas esperam a MESMA consulta, em vez de
 * cada uma disparar a sua (*cache stampede*).
 *
 * **Fail-open, com o último valor conhecido:** se a leitura falhar, vale a política anterior por mais um ciclo; se
 * nunca houve uma, nenhuma (tudo passa). O contrário (*fail-closed*) bloquearia todos os apps por uma falha de leitura
 * de configuração: um incidente muito maior do que deixar uma versão velha passar por alguns minutos.
 */
@Injectable()
export class VersionPolicyService {
  private readonly logger = new Logger(VersionPolicyService.name);
  private readonly ttlMs: number;
  private cached: { policies: Policies; expiresAt: number } | undefined;
  private loading: Promise<Policies> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('APP_VERSION_POLICY_CACHE_TTL_MS', { infer: true });
  }

  async policyFor(platform: Platform): Promise<VersionPolicy | undefined> {
    if (platform === 'unknown') return undefined; // nem consulta: não há política para quem não se identifica
    return (await this.policies()).get(platform);
  }

  private policies(): Promise<Policies> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return Promise.resolve(this.cached.policies);
    }
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async load(): Promise<Policies> {
    try {
      const rows = await this.prisma.appVersionPolicy.findMany();
      const policies = new Map<Platform, VersionPolicy>(
        rows.map((row) => [
          row.platform,
          {
            minVersion: parseAppVersion(row.minVersion),
            recommendedVersion: parseAppVersion(row.recommendedVersion),
          },
        ]),
      );
      this.cached = { policies, expiresAt: Date.now() + this.ttlMs };
      return policies;
    } catch (error) {
      const fallback =
        this.cached?.policies ?? new Map<Platform, VersionPolicy>();
      // Mais um ciclo com o valor antigo: sem isso, cada requisição tentaria o banco de novo enquanto ele está fora
      this.cached = { policies: fallback, expiresAt: Date.now() + this.ttlMs };
      this.logger.warn(
        `Política de versão do app indisponível; ${fallback.size > 0 ? 'mantendo a última conhecida' : 'sem política (tudo passa)'}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }
}
