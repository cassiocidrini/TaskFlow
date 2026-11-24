import type { EvaluationContext } from './feature-flag.rules';

/**
 * Porta das feature flags (Módulo 14.6): o resto do sistema só conhece isto. Classe abstrata (e não interface) para
 * servir de token de injeção do Nest, como o `TaskRepository` e a `PushQueue`.
 *
 * O adapter de hoje é o Postgres com cache (`PostgresFeatureFlags`). Trocar por um serviço gerenciado (LaunchDarkly,
 * Unleash) seria escrever outro adapter, sem mexer em quem pergunta pela flag (ADR-0010).
 */
export abstract class FeatureFlags {
  /** A flag está ligada para este usuário e este app? Flag inexistente = `false`. */
  abstract isEnabled(
    flagKey: string,
    context: EvaluationContext,
  ): Promise<boolean>;

  /** Todas as flags existentes, avaliadas para este usuário e este app (o `GET /me/features`). */
  abstract evaluateAll(
    context: EvaluationContext,
  ): Promise<Record<string, boolean>>;
}
