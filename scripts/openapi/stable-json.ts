/**
 * JSON determinístico para o snapshot do contrato da API (Módulo 14.3): chaves de OBJETO em ordem alfabética, em todos
 * os níveis; ordem de ARRAY preservada.
 *
 * Por que ordenar: o Nest monta o documento na ordem em que encontra controllers e DTOs. Mover um método no arquivo ou
 * mudar a ordem dos imports mudaria o JSON sem mudar o contrato, e o diff do PR mostraria uma "mudança" que não existe.
 *
 * Por que NÃO ordenar arrays: neles a ordem é informação (a ordem dos parâmetros, dos valores de um `enum`, das tags
 * na documentação). Ordená-los esconderia uma mudança real.
 */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
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
