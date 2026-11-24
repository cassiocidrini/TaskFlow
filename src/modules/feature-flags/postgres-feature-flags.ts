import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { metrics } from '@opentelemetry/api';
import { parseAppVersion } from '../../common/client/app-version';
import type { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type EvaluationContext,
  evaluate,
  type FlagRule,
} from './feature-flag.rules';
import { FeatureFlags } from './feature-flags';

type Rules = ReadonlyMap<string, FlagRule>;

/**
 * Adapter Postgres da porta {@link FeatureFlags} (Módulo 14.6): lê TODAS as regras (são poucas) com cache em memória
 * e avalia localmente, sem chamada de rede por requisição.
 *
 * **Cache de 5 s** (`FEATURE_FLAGS_CACHE_TTL_MS`): menor que os 30 s da versão mínima (14.2), porque o kill switch
 * precisa valer rápido em todas as réplicas. Uma leitura por vez quando vence (sem *cache stampede*), como o
 * `VersionPolicyService`.
 *
 * **Fail-closed, o contrário da versão mínima.** Se a leitura falhar, vale a última configuração conhecida por mais um
 * ciclo; se NUNCA houve uma, nenhuma regra, e toda flag fica desligada (`evaluate` de flag inexistente). Na versão
 * mínima o desastre seria BLOQUEAR todo mundo, então lá a falha deixa passar; aqui o desastre seria LIGAR algo para
 * todos, então a falha desliga. O lado seguro depende do que a falha causa.
 */
@Injectable()
export class PostgresFeatureFlags extends FeatureFlags {
  private readonly logger = new Logger(PostgresFeatureFlags.name);
  private readonly ttlMs: number;
  private cached: { rules: Rules; expiresAt: number } | undefined;
  private loading: Promise<Rules> | undefined;
  private readonly evaluations = metrics
    .getMeter('taskflow-api')
    .createCounter('taskflow_feature_flag_evaluations', {
      description:
        'Avaliações de feature flag, por flag e resultado (o nome da flag é seguro como label: são poucas e nossas)',
    });

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    super();
    this.ttlMs = config.get('FEATURE_FLAGS_CACHE_TTL_MS', { infer: true });
  }

  async isEnabled(
    flagKey: string,
    context: EvaluationContext,
  ): Promise<boolean> {
    return this.evaluateOne(
      (await this.rules()).get(flagKey),
      flagKey,
      context,
    );
  }

  async evaluateAll(
    context: EvaluationContext,
  ): Promise<Record<string, boolean>> {
    const rules = await this.rules();
    return Object.fromEntries(
      [...rules.keys()]
        .sort()
        .map((key) => [key, this.evaluateOne(rules.get(key), key, context)]),
    );
  }

  private evaluateOne(
    rule: FlagRule | undefined,
    flagKey: string,
    context: EvaluationContext,
  ): boolean {
    const result = evaluate(rule, context);
    // Só flags que existem viram label: uma chave inventada pelo código não cria série nova
    if (rule) {
      this.evaluations.add(1, {
        flag: flagKey,
        enabled: String(result.enabled),
        reason: result.reason,
      });
    }
    return result.enabled;
  }

  private rules(): Promise<Rules> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return Promise.resolve(this.cached.rules);
    }
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async load(): Promise<Rules> {
    try {
      const rows = await this.prisma.featureFlag.findMany();
      const rules = new Map<string, FlagRule>(
        rows.map((row) => [
          row.key,
          {
            key: row.key,
            enabled: row.enabled,
            rolloutPercentage: row.rolloutPercentage,
            allowUserIds: row.allowUserIds,
            platforms: row.platforms,
            minAppVersion: parseAppVersion(row.minAppVersion),
          },
        ]),
      );
      this.cached = { rules, expiresAt: Date.now() + this.ttlMs };
      return rules;
    } catch (error) {
      const fallback = this.cached?.rules ?? new Map<string, FlagRule>();
      // Mais um ciclo com o valor antigo: sem isso, cada requisição tentaria o banco de novo enquanto ele está fora
      this.cached = { rules: fallback, expiresAt: Date.now() + this.ttlMs };
      this.logger.warn(
        `Feature flags indisponíveis; ${fallback.size > 0 ? 'mantendo a última configuração conhecida' : 'todas desligadas (fail-closed)'}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }
}
