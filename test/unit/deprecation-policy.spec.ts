/**
 * Política de depreciação no CI (Módulo 14.8, ADR-0012): todo campo depreciado declarado em `DEPRECATED_FIELDS` tem
 * pelo menos 90 dias entre o `Deprecation` e o `Sunset`.
 *
 * Por que um teste, e não só o ADR: o prazo é uma promessa a quem desenvolve o app (publicar uma versão sem o campo e
 * os usuários atualizarem). Um `Sunset` curto demais, declarado por engano, quebra o build em vez de virar um
 * contrato que ninguém consegue cumprir.
 *
 * A lista real está vazia hoje (o `dueDate`, o último, já saiu). Por isso a regra também é provada com campos de
 * exemplo: um teste que só rodasse sobre a lista vazia passaria mesmo com a regra quebrada.
 */
import {
  DEPRECATED_FIELDS,
  type DeprecatedField,
  MIN_DEPRECATION_NOTICE_DAYS,
  violatesNoticePolicy,
} from '../../src/common/deprecation/deprecation';

const field = (
  name: string,
  deprecatedAt: string,
  sunsetAt: string,
): DeprecatedField => ({
  name,
  deprecatedAt: new Date(deprecatedAt),
  sunsetAt: new Date(sunsetAt),
  link: 'https://example.com/migracao',
});

describe('política de depreciação (ADR-0012)', () => {
  it(`todo campo depreciado declarado tem pelo menos ${MIN_DEPRECATION_NOTICE_DAYS} dias de aviso`, () => {
    expect(violatesNoticePolicy(DEPRECATED_FIELDS).map((f) => f.name)).toEqual(
      [],
    );
  });

  it('a regra pega o aviso curto: 89 dias não, 90 sim (o dueDate da 14.4 teve 97)', () => {
    const curto = field(
      'curto',
      '2026-11-24T00:00:00Z',
      '2027-02-21T00:00:00Z',
    ); // 89 dias
    const exato = field(
      'exato',
      '2026-11-24T00:00:00Z',
      '2027-02-22T00:00:00Z',
    ); // 90 dias
    const dueDate = field(
      'dueDate',
      '2026-11-24T00:00:00Z',
      '2027-03-01T00:00:00Z',
    ); // 97 dias

    expect(
      violatesNoticePolicy([curto, exato, dueDate]).map((f) => f.name),
    ).toEqual(['curto']);
  });
});
