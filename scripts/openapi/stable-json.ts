import { stableStringify as stableJson } from '../../src/common/json/stable-json';

/**
 * O snapshot do contrato da API (Módulo 14.3): a serialização estável de `src/common/json/stable-json.ts` (a mesma do
 * hash da `Idempotency-Key`, 14.5), com indentação de 2 e quebra de linha final (diff limpo no Git).
 */
export function stableStringify(value: unknown): string {
  return `${stableJson(value, 2)}\n`;
}

/**
 * As primeiras linhas diferentes entre dois textos, com o número da linha: o suficiente para quem vê o CI falhar
 * entender o que mudou sem baixar nada. O diff completo é o do próprio PR, depois do `openapi:generate`.
 */
export function firstDifferences(
  expected: string,
  actual: string,
  max = 10,
): string[] {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && lines.length < max; i++) {
    if (a[i] !== b[i]) {
      lines.push(
        `linha ${i + 1}:\n  - snapshot: ${a[i] ?? '(fim)'}\n  + código:   ${b[i] ?? '(fim)'}`,
      );
    }
  }
  return lines;
}
