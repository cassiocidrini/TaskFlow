/**
 * Versão de loja de um app (App Store, Play Store): `MAJOR.MINOR.PATCH`, só números (Módulo 14.1).
 *
 * Parser próprio, e não o pacote `semver`: versão de loja não tem pré-release (`-beta.1`) nem metadata de build
 * (`+build.5`), que são quase todo o trabalho do pacote. O que importa aqui cabe em 20 linhas testadas.
 *
 * Até 4 dígitos por parte, sem zero à esquerda: `01.2.3` e `99999.0.0` são recusados. O valor vem de um header que o
 * cliente controla e vai parar em logs, spans e, truncado, numa label de métrica.
 */
export interface AppVersion {
  major: number;
  minor: number;
  patch: number;
}

const STORE_VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

/** `null` para qualquer coisa que não seja exatamente `MAJOR.MINOR.PATCH`. Nunca lança. */
export function parseAppVersion(raw: unknown): AppVersion | null {
  if (typeof raw !== 'string') return null;
  const match = STORE_VERSION.exec(raw);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Negativo se `a < b`, zero se iguais, positivo se `a > b`. Compara NÚMERO a número: como string, `"1.10.0"` seria
 * menor que `"1.9.0"`, o erro clássico que bloquearia a versão mais nova do app.
 */
export function compareAppVersions(a: AppVersion, b: AppVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function formatAppVersion(version: AppVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}
