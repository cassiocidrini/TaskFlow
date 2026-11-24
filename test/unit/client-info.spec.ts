/**
 * Identificação do cliente (Módulo 14.1): parser da versão de loja, resolução dos headers e a label de métrica.
 *
 * Protege três promessas:
 * - a comparação de versões é NUMÉRICA (`1.10.0 > 1.9.0`): comparar como texto bloquearia a versão mais nova do app
 *   quando a versão mínima (14.2) usar esta função;
 * - header inválido, repetido ou ausente nunca lança: vira cliente desconhecido (identificar não derruba requisição);
 * - a label de métrica tem cardinalidade limitada (`MAJOR.MINOR`, `none`, `other`), porque o valor vem do cliente.
 */
import {
  compareAppVersions,
  formatAppVersion,
  parseAppVersion,
} from '../../src/common/client/app-version';
import {
  appVersionLabel,
  describeClient,
  resolveClientInfo,
} from '../../src/common/client/client-info';

describe('parseAppVersion', () => {
  it('lê MAJOR.MINOR.PATCH', () => {
    expect(parseAppVersion('2.14.0')).toEqual({
      major: 2,
      minor: 14,
      patch: 0,
    });
    expect(parseAppVersion('0.0.1')).toEqual({ major: 0, minor: 0, patch: 1 });
  });

  it.each([
    ['2.14', 'sem PATCH'],
    ['2.14.0-beta.1', 'pré-release (não existe em versão de loja)'],
    ['2.14.0+5', 'metadata de build'],
    ['v2.14.0', 'prefixo'],
    ['02.14.0', 'zero à esquerda'],
    ['12345.0.0', 'mais de 4 dígitos'],
    [' 2.14.0', 'espaço'],
    ['2.14.0\nX-Fake: 1', 'quebra de linha (log injection)'],
    ['', 'vazio'],
  ])('recusa %j (%s)', (raw) => {
    expect(parseAppVersion(raw)).toBeNull();
  });

  it('recusa o que não é string (header repetido chega como lista)', () => {
    expect(parseAppVersion(['2.14.0', '2.15.0'])).toBeNull();
    expect(parseAppVersion(undefined)).toBeNull();
  });
});

describe('compareAppVersions', () => {
  const v = (raw: string) => parseAppVersion(raw)!;

  it('compara número a número, não como texto: 1.10.0 > 1.9.0', () => {
    expect(compareAppVersions(v('1.10.0'), v('1.9.0'))).toBeGreaterThan(0);
    // O erro que a comparação como texto cometeria: em ordem de string, a 1.10.0 vem ANTES da 1.9.0
    expect(['1.9.0', '1.10.0'].sort()).toEqual(['1.10.0', '1.9.0']);
  });

  it('MAJOR manda sobre MINOR, que manda sobre PATCH', () => {
    expect(compareAppVersions(v('2.0.0'), v('1.99.99'))).toBeGreaterThan(0);
    expect(compareAppVersions(v('1.2.0'), v('1.1.9'))).toBeGreaterThan(0);
    expect(compareAppVersions(v('1.2.3'), v('1.2.4'))).toBeLessThan(0);
    expect(compareAppVersions(v('1.2.3'), v('1.2.3'))).toBe(0);
  });

  it('formata de volta para o texto original', () => {
    expect(formatAppVersion(v('2.14.0'))).toBe('2.14.0');
  });
});

describe('resolveClientInfo', () => {
  it('plataforma e versão válidas', () => {
    expect(resolveClientInfo('ios', '2.14.0')).toEqual({
      platform: 'ios',
      appVersion: { major: 2, minor: 14, patch: 0 },
    });
  });

  it('plataforma sem diferenciar maiúsculas (os apps mandam "iOS")', () => {
    expect(resolveClientInfo('iOS', undefined).platform).toBe('ios');
    expect(resolveClientInfo('Android', undefined).platform).toBe('android');
  });

  it('ausente, desconhecida ou repetida: unknown, sem lançar', () => {
    expect(resolveClientInfo(undefined, undefined)).toEqual({
      platform: 'unknown',
      appVersion: null,
    });
    expect(resolveClientInfo('windows-phone', 'abc').platform).toBe('unknown');
    expect(resolveClientInfo(['ios', 'android'], undefined).platform).toBe(
      'unknown',
    );
  });

  it('a versão é lida mesmo sem plataforma (e vice-versa)', () => {
    expect(resolveClientInfo(undefined, '1.0.0').appVersion).not.toBeNull();
    expect(resolveClientInfo('web', 'lixo')).toEqual({
      platform: 'web',
      appVersion: null,
    });
  });
});

describe('appVersionLabel (cardinalidade da métrica)', () => {
  it('MAJOR.MINOR: o PATCH não vira série nova', () => {
    expect(appVersionLabel(resolveClientInfo('ios', '2.14.0'))).toBe('2.14');
    expect(appVersionLabel(resolveClientInfo('ios', '2.14.7'))).toBe('2.14');
  });

  it('sem versão: none; fora da faixa: other', () => {
    expect(appVersionLabel(resolveClientInfo('ios', undefined))).toBe('none');
    expect(appVersionLabel(resolveClientInfo('ios', '100.0.0'))).toBe('other');
    expect(appVersionLabel(resolveClientInfo('ios', '1.100.0'))).toBe('other');
    expect(appVersionLabel(resolveClientInfo('ios', '99.99.9999'))).toBe(
      '99.99',
    );
  });

  it('describeClient: a versão completa, para span e log', () => {
    expect(describeClient(resolveClientInfo('android', '2.14.7'))).toEqual({
      platform: 'android',
      appVersion: '2.14.7',
    });
    expect(describeClient(resolveClientInfo(undefined, undefined))).toEqual({
      platform: 'unknown',
      appVersion: null,
    });
  });
});
