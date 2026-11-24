import {
  type AppVersion,
  formatAppVersion,
  parseAppVersion,
} from './app-version';

/** Headers que identificam o cliente (Módulo 14.1). O Express normaliza os nomes recebidos para minúsculas. */
export const PLATFORM_HEADER = 'X-Platform';
export const APP_VERSION_HEADER = 'X-App-Version';

export const PLATFORMS = ['ios', 'android', 'web'] as const;
/** `unknown`: header ausente ou fora da lista (curl, integrações, front antigo). */
export type Platform = (typeof PLATFORMS)[number] | 'unknown';

/**
 * Quem está chamando a API: a plataforma e a versão do app (ou do build do front web).
 *
 * **Não é identidade nem autorização.** Os dois valores vêm de headers que o cliente controla: qualquer um manda
 * `X-App-Version: 99.0.0`. Servem para compatibilidade e experiência (avisar o app antigo, escolher o formato de
 * resposta, medir a adoção de uma versão), nunca para decidir o que alguém pode fazer. Provar que a chamada vem do
 * app legítimo seria *app attestation* (App Attest, Play Integrity), fora do escopo.
 */
export interface ClientInfo {
  platform: Platform;
  /** `null` quando ausente ou inválida. */
  appVersion: AppVersion | null;
}

export const UNKNOWN_CLIENT: ClientInfo = Object.freeze({
  platform: 'unknown',
  appVersion: null,
});

/**
 * Lê os headers e devolve o cliente. Valor inválido NÃO vira erro, vira `unknown`/`null`: identificar o cliente é
 * diagnóstico e política, e não pode derrubar uma requisição legítima (o mesmo princípio do `X-Correlation-Id`).
 * Header repetido chega como lista (ou unido por vírgula) e também cai em desconhecido.
 */
export function resolveClientInfo(
  platformHeader: string | string[] | undefined,
  versionHeader: string | string[] | undefined,
): ClientInfo {
  const platform =
    typeof platformHeader === 'string'
      ? PLATFORMS.find((p) => p === platformHeader.trim().toLowerCase())
      : undefined;
  return {
    platform: platform ?? 'unknown',
    appVersion: parseAppVersion(versionHeader),
  };
}

/**
 * Teto da versão que vira label de métrica. Acima dele, `other`. Junto com o truncamento em `MAJOR.MINOR`, limita as
 * séries que um cliente mal-intencionado consegue criar mandando versões inventadas: no pior caso, 4 plataformas ×
 * (100 × 100 + 2). É uma contenção, não a defesa definitiva, que seria aceitar só os releases conhecidos.
 */
const MAX_LABELED_PART = 99;

/**
 * A versão como label de métrica: `MAJOR.MINOR` (o PATCH multiplicaria as séries sem mudar nenhuma decisão de
 * compatibilidade), `none` sem versão e `other` fora da faixa. A versão completa vai para o span e o log, onde
 * cardinalidade alta não custa nada.
 */
export function appVersionLabel(client: ClientInfo): string {
  const version = client.appVersion;
  if (!version) return 'none';
  if (version.major > MAX_LABELED_PART || version.minor > MAX_LABELED_PART) {
    return 'other';
  }
  return `${version.major}.${version.minor}`;
}

/** Forma do cliente nos logs e nos spans: a versão completa como texto. */
export function describeClient(client: ClientInfo): {
  platform: Platform;
  appVersion: string | null;
} {
  return {
    platform: client.platform,
    appVersion: client.appVersion ? formatAppVersion(client.appVersion) : null,
  };
}
