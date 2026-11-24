/**
 * Serialização do snapshot do contrato da API (Módulo 14.3).
 *
 * Protege a propriedade que faz o snapshot servir para revisão: o MESMO contrato gera o MESMO texto, qualquer que seja
 * a ordem em que o Nest montou o documento. Sem isso, mover um método de lugar mudaria o `docs/api/openapi.json` e o
 * diff do PR mostraria uma "mudança" falsa. E a ordem dos ARRAYS é preservada, porque nela há informação (parâmetros,
 * valores de enum): ordenar esconderia uma mudança real.
 *
 * O snapshot em si é conferido pelo `npm run openapi:check` no CI, contra o código compilado (o plugin do Swagger só
 * roda no `nest build`, não no Jest).
 */
import {
  firstDifferences,
  stableStringify,
} from '../../scripts/openapi/stable-json';

describe('stableStringify', () => {
  it('a mesma estrutura em ordens diferentes gera o mesmo texto, em todos os níveis', () => {
    const a = {
      paths: { '/b': { get: {} }, '/a': { post: {}, get: {} } },
      info: { version: '1', title: 'T' },
    };
    const b = {
      info: { title: 'T', version: '1' },
      paths: { '/a': { get: {}, post: {} }, '/b': { get: {} } },
    };

    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(Object.keys(JSON.parse(stableStringify(a)) as object)).toEqual([
      'info',
      'paths',
    ]);
  });

  it('preserva a ordem dos arrays (nela há informação)', () => {
    const parsed = JSON.parse(
      stableStringify({ enum: ['PENDING', 'IN_PROGRESS', 'DONE'] }),
    ) as { enum: string[] };
    expect(parsed.enum).toEqual(['PENDING', 'IN_PROGRESS', 'DONE']);
    expect(stableStringify({ enum: ['b', 'a'] })).not.toBe(
      stableStringify({ enum: ['a', 'b'] }),
    );
  });

  it('ordena objetos dentro de arrays, e termina com quebra de linha (diff limpo no Git)', () => {
    expect(stableStringify([{ b: 1, a: 2 }])).toBe(
      '[\n  {\n    "a": 2,\n    "b": 1\n  }\n]\n',
    );
  });
});

describe('firstDifferences', () => {
  it('aponta a linha e os dois lados', () => {
    expect(firstDifferences('a\nb\nc', 'a\nX\nc')).toEqual([
      'linha 2:\n  - snapshot: b\n  + código:   X',
    ]);
  });

  it('linha a mais de um lado aparece como fim do outro; limita a quantidade', () => {
    expect(firstDifferences('a', 'a\nnova')).toEqual([
      'linha 2:\n  - snapshot: (fim)\n  + código:   nova',
    ]);
    expect(firstDifferences('1\n2\n3', 'x\ny\nz', 2)).toHaveLength(2);
  });
});
