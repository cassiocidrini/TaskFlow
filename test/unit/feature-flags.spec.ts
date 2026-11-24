/**
 * Feature flags (Módulo 14.6): a regra de avaliação, o bucket e o cache *fail-closed* do adapter, sem banco.
 *
 * Protege:
 * - a ORDEM das regras: inexistente → kill switch (vence até a lista de usuários) → restrições de plataforma e versão
 *   (cliente desconhecido não passa por uma restrição) → lista de usuários → porcentagem;
 * - as três propriedades do bucket, com 10 mil usuários simulados: determinístico (mesmo grupo sempre), monotônico
 *   (subir de 10% para 20% não tira ninguém dos primeiros 10%), independente entre flags (cada flag sorteia os seus);
 *   e que 10% dá ~10% de verdade;
 * - o adapter: leitura única com o cache vencido, a última configuração mantida se o banco cair, e TODAS as flags
 *   desligadas se nunca houve leitura (fail-closed, o contrário da versão mínima).
 */
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { parseAppVersion } from '../../src/common/client/app-version';
import { resolveClientInfo } from '../../src/common/client/client-info';
import type { Env } from '../../src/config/env.schema';
import {
  bucket,
  evaluate,
  type FlagRule,
} from '../../src/modules/feature-flags/feature-flag.rules';
import { PostgresFeatureFlags } from '../../src/modules/feature-flags/postgres-feature-flags';
import type { PrismaService } from '../../src/prisma/prisma.service';

const rule = (overrides: Partial<FlagRule> = {}): FlagRule => ({
  key: 'tela-nova',
  enabled: true,
  rolloutPercentage: 0,
  allowUserIds: [],
  platforms: [],
  minAppVersion: null,
  ...overrides,
});
const ios = (version = '2.15.0') => resolveClientInfo('ios', version);
const ctx = (userId = 'u1', client = ios()) => ({ userId, client });

describe('evaluate: a ordem das regras', () => {
  it('flag inexistente: desligada', () => {
    expect(evaluate(undefined, ctx())).toEqual({
      enabled: false,
      reason: 'missing',
    });
  });

  it('kill switch vence TUDO, inclusive a lista de usuários e 100%', () => {
    const killed = rule({
      enabled: false,
      rolloutPercentage: 100,
      allowUserIds: ['u1'],
    });
    expect(evaluate(killed, ctx('u1'))).toEqual({
      enabled: false,
      reason: 'killed',
    });
  });

  it('restrição de plataforma: fora da lista ou desconhecida, desligada (mesmo na lista de usuários)', () => {
    const onlyMobile = rule({
      platforms: ['ios', 'android'],
      rolloutPercentage: 100,
      allowUserIds: ['u1'],
    });
    expect(
      evaluate(onlyMobile, ctx('u1', resolveClientInfo('web', '2.15.0')))
        .reason,
    ).toBe('platform');
    expect(
      evaluate(onlyMobile, ctx('u1', resolveClientInfo(undefined, undefined)))
        .reason,
    ).toBe('platform');
    expect(evaluate(onlyMobile, ctx('u1')).enabled).toBe(true);
  });

  it('versão mínima: abaixo, ou sem versão, desligada (comparação numérica: 2.9 < 2.15)', () => {
    const fromV215 = rule({
      minAppVersion: parseAppVersion('2.15.0'),
      rolloutPercentage: 100,
    });
    expect(evaluate(fromV215, ctx('u1', ios('2.9.0'))).reason).toBe(
      'app-version',
    );
    expect(
      evaluate(fromV215, ctx('u1', resolveClientInfo('ios', undefined))).reason,
    ).toBe('app-version');
    expect(evaluate(fromV215, ctx('u1', ios('2.15.0'))).enabled).toBe(true);
  });

  it('lista de usuários: ligada mesmo com 0%', () => {
    expect(evaluate(rule({ allowUserIds: ['tester'] }), ctx('tester'))).toEqual(
      { enabled: true, reason: 'allowlist' },
    );
  });

  it('porcentagem: 0% ninguém, 100% todos', () => {
    expect(evaluate(rule({ rolloutPercentage: 0 }), ctx()).reason).toBe(
      'outside-rollout',
    );
    expect(evaluate(rule({ rolloutPercentage: 100 }), ctx())).toEqual({
      enabled: true,
      reason: 'rollout',
    });
  });
});

describe('bucket: sha256(flag:usuário) mod 100', () => {
  const users = Array.from({ length: 10_000 }, () => randomUUID());
  const enabledAt = (flag: string, rollout: number) =>
    new Set(
      users.filter(
        (u) =>
          evaluate(rule({ key: flag, rolloutPercentage: rollout }), ctx(u))
            .enabled,
      ),
    );

  it('determinístico: o mesmo usuário cai sempre no mesmo grupo', () => {
    for (const u of users.slice(0, 100))
      expect(bucket('tela-nova', u)).toBe(bucket('tela-nova', u));
  });

  it('10% liga ~10% dos usuários (10 mil simulados, tolerância de ±1,5 ponto)', () => {
    const share = enabledAt('tela-nova', 10).size / users.length;
    expect(share).toBeGreaterThan(0.085);
    expect(share).toBeLessThan(0.115);
  });

  it('monotônico: subir de 10% para 20% não tira NINGUÉM dos primeiros 10%', () => {
    const at10 = enabledAt('tela-nova', 10);
    const at20 = enabledAt('tela-nova', 20);
    expect([...at10].every((u) => at20.has(u))).toBe(true);
    expect(at20.size).toBeGreaterThan(at10.size);
  });

  it('independente entre flags: cada flag sorteia os seus 10% (não são sempre as mesmas cobaias)', () => {
    const a = enabledAt('tela-nova', 10);
    const b = enabledAt('outra-tela', 10);
    const overlap = [...a].filter((u) => b.has(u)).length / a.size;
    // Independentes: ~10% dos de A também estão em B. Com o mesmo sorteio, seriam 100%
    expect(overlap).toBeLessThan(0.2);
  });
});

describe('PostgresFeatureFlags: cache e fail-closed', () => {
  const row = (key: string, enabled = true) => ({
    key,
    description: '',
    enabled,
    rolloutPercentage: 100,
    allowUserIds: [],
    platforms: [],
    minAppVersion: null,
    updatedBy: 'x',
    updatedAt: new Date(),
  });
  let findMany: jest.Mock;
  let now: jest.SpyInstance;
  let flags: PostgresFeatureFlags;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([row('tela-nova')]);
    now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    flags = new PostgresFeatureFlags(
      { featureFlag: { findMany } } as unknown as PrismaService,
      { get: () => 5_000 } as unknown as ConfigService<Env, true>,
    );
  });

  afterEach(() => now.mockRestore());

  it('20 avaliações simultâneas com o cache vazio: UMA leitura', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => flags.isEnabled('tela-nova', ctx())),
    );
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('kill switch vale quando o cache vence (5 s), sem reiniciar', async () => {
    expect(await flags.isEnabled('tela-nova', ctx())).toBe(true);
    findMany.mockResolvedValue([row('tela-nova', false)]);
    now.mockReturnValue(1_000_000 + 4_999);
    expect(await flags.isEnabled('tela-nova', ctx())).toBe(true); // ainda no cache
    now.mockReturnValue(1_000_000 + 5_000);
    expect(await flags.isEnabled('tela-nova', ctx())).toBe(false);
  });

  it('banco fora: mantém a última configuração conhecida', async () => {
    await flags.isEnabled('tela-nova', ctx());
    findMany.mockRejectedValue(new Error('banco fora'));
    now.mockReturnValue(1_000_000 + 60_000);
    expect(await flags.isEnabled('tela-nova', ctx())).toBe(true);
  });

  it('banco fora e nunca houve leitura: TODAS desligadas (fail-closed)', async () => {
    findMany.mockRejectedValue(new Error('banco fora'));
    expect(await flags.isEnabled('tela-nova', ctx())).toBe(false);
    expect(await flags.evaluateAll(ctx())).toEqual({});
  });

  it('evaluateAll: todas as flags existentes, em ordem, só com o resultado', async () => {
    findMany.mockResolvedValue([row('b-flag'), row('a-flag', false)]);
    expect(await flags.evaluateAll(ctx())).toEqual({
      'a-flag': false,
      'b-flag': true,
    });
  });
});
