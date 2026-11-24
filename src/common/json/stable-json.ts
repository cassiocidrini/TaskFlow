/**
 * JSON determinístico: chaves de OBJETO em ordem alfabética, em todos os níveis; ordem de ARRAY preservada.
 *
 * Usado onde o MESMO conteúdo precisa gerar o MESMO texto, qualquer que seja a ordem em que foi montado:
 * - o snapshot do contrato da API (Módulo 14.3, `scripts/openapi/`): sem isso, mover um método de lugar mudaria o
 *   arquivo e o diff do PR mostraria uma "mudança" falsa;
 * - o hash do pedido da `Idempotency-Key` (Módulo 14.5): `{ "a": 1, "b": 2 }` e `{ "b": 2, "a": 1 }` são o MESMO
 *   pedido, e não podem virar um 422 de "chave reaproveitada".
 *
 * Arrays NÃO são ordenados: neles a ordem é informação (parâmetros, valores de `enum`, itens de uma lista).
 */
export function stableStringify(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined) // como o JSON.stringify: undefined não existe em JSON
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}
