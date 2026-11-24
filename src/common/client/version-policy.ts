import { type AppVersion, compareAppVersions } from './app-version';
import type { ClientInfo } from './client-info';

/** Política de versão de UMA plataforma (Módulo 14.2). As duas são opcionais; o banco exige pelo menos uma. */
export interface VersionPolicy {
  /** Abaixo dela, a API recusa com 426 (`APP_UPDATE_REQUIRED`). */
  minVersion: AppVersion | null;
  /** Abaixo dela (e acima da mínima), a API atende e avisa: `X-App-Update: recommended`. */
  recommendedVersion: AppVersion | null;
}

export type VersionDecision =
  | { kind: 'ok' }
  | { kind: 'update-recommended'; recommendedVersion: AppVersion }
  | { kind: 'update-required'; minVersion: AppVersion };

const OK: VersionDecision = Object.freeze({ kind: 'ok' });

/**
 * O que fazer com uma requisição, dado o cliente e a política da plataforma dele. Função PURA: a regra inteira é
 * testada sem banco nem HTTP.
 *
 * **Quem não se identifica passa** (sem versão, plataforma `unknown`, plataforma sem política). Bloquear quem não manda
 * o header quebraria curl, integrações e o front antigo, e não protegeria nada: o header não prova nada (14.1), e um
 * app que quisesse escapar do bloqueio era só não mandá-lo. A versão mínima protege o USUÁRIO de um app quebrado,
 * não a API de um atacante.
 */
export function evaluateClient(
  client: ClientInfo,
  policy: VersionPolicy | undefined,
): VersionDecision {
  const version = client.appVersion;
  if (!policy || !version) return OK;
  if (policy.minVersion && compareAppVersions(version, policy.minVersion) < 0) {
    return { kind: 'update-required', minVersion: policy.minVersion };
  }
  if (
    policy.recommendedVersion &&
    compareAppVersions(version, policy.recommendedVersion) < 0
  ) {
    return {
      kind: 'update-recommended',
      recommendedVersion: policy.recommendedVersion,
    };
  }
  return OK;
}
