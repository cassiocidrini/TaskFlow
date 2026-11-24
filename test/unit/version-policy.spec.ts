/**
 * Versão mínima do app (Módulo 14.2): a decisão pura, o cache do serviço e o middleware, sem banco nem HTTP real.
 *
 * Protege:
 * - a regra: abaixo da mínima = 426; abaixo da recomendada = atende e avisa; quem não se identifica passa;
 * - o cache: dentro do TTL não consulta o banco; requisições simultâneas com o cache vencido fazem UMA consulta
 *   (sem *cache stampede*); plataforma `unknown` nem consulta;
 * - o *fail-open*: banco fora mantém a última política conhecida e, sem nenhuma, deixa passar (nunca bloqueia todos
 *   os apps por falha de configuração);
 * - o middleware: corpo do 426 com o `code` estável, headers do aviso, probes de health intocados, erro inesperado
 *   entregue ao Express (`next(err)`), e não engolido.
 */
import type { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { parseAppVersion } from '../../src/common/client/app-version';
import { resolveClientInfo } from '../../src/common/client/client-info';
import type { RequestWithClient } from '../../src/common/client/client-info.middleware';
import {
  APP_UPDATE_REQUIRED,
  VersionGateMiddleware,
} from '../../src/common/client/version-gate.middleware';
import {
  evaluateClient,
  type VersionPolicy,
} from '../../src/common/client/version-policy';
import { VersionPolicyService } from '../../src/common/client/version-policy.service';
import type { Env } from '../../src/config/env.schema';
import type { PrismaService } from '../../src/prisma/prisma.service';

const v = (raw: string) => parseAppVersion(raw)!;
const policy = (
  min: string | null,
  recommended: string | null,
): VersionPolicy => ({
  minVersion: min ? v(min) : null,
  recommendedVersion: recommended ? v(recommended) : null,
});

describe('evaluateClient', () => {
  const ios = (version: string) => resolveClientInfo('ios', version);
  const rule = policy('2.10.0', '2.12.0');

  it('abaixo da mínima: update-required (comparação numérica: 2.9.9 < 2.10.0)', () => {
    expect(evaluateClient(ios('2.9.9'), rule)).toEqual({
      kind: 'update-required',
      minVersion: v('2.10.0'),
    });
  });

  it('entre a mínima e a recomendada: update-recommended; na mínima exata também', () => {
    expect(evaluateClient(ios('2.10.0'), rule).kind).toBe('update-recommended');
    expect(evaluateClient(ios('2.11.5'), rule)).toEqual({
      kind: 'update-recommended',
      recommendedVersion: v('2.12.0'),
    });
  });

  it('na recomendada ou acima: ok', () => {
    expect(evaluateClient(ios('2.12.0'), rule).kind).toBe('ok');
    expect(evaluateClient(ios('3.0.0'), rule).kind).toBe('ok');
  });

  it('quem não se identifica, ou plataforma sem política, passa', () => {
    expect(evaluateClient(resolveClientInfo('ios', undefined), rule).kind).toBe(
      'ok',
    );
    expect(
      evaluateClient(resolveClientInfo(undefined, '1.0.0'), undefined).kind,
    ).toBe('ok');
    expect(evaluateClient(ios('1.0.0'), undefined).kind).toBe('ok');
  });

  it('só mínima, ou só recomendada', () => {
    expect(evaluateClient(ios('1.0.0'), policy('2.0.0', null)).kind).toBe(
      'update-required',
    );
    expect(evaluateClient(ios('1.0.0'), policy(null, '2.0.0')).kind).toBe(
      'update-recommended',
    );
  });
});

describe('VersionPolicyService', () => {
  const row = (
    platform: string,
    min: string | null,
    recommended: string | null,
  ) => ({
    platform,
    minVersion: min,
    recommendedVersion: recommended,
  });
  let findMany: jest.Mock;
  let now: jest.SpyInstance;
  let service: VersionPolicyService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([row('ios', '2.10.0', null)]);
    now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const prisma = {
      appVersionPolicy: { findMany },
    } as unknown as PrismaService;
    const config = { get: () => 30_000 } as unknown as ConfigService<Env, true>;
    service = new VersionPolicyService(prisma, config);
  });

  afterEach(() => now.mockRestore());

  it('dentro do TTL, não consulta de novo; vencido, consulta', async () => {
    await service.policyFor('ios');
    now.mockReturnValue(1_000_000 + 29_999);
    await service.policyFor('android');
    expect(findMany).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 30_000);
    await service.policyFor('ios');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('20 requisições simultâneas com o cache vazio: UMA consulta (sem cache stampede)', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.policyFor('ios')),
    );
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(results.every((p) => p?.minVersion?.minor === 10)).toBe(true);
  });

  it('plataforma unknown nem consulta o banco', async () => {
    expect(await service.policyFor('unknown')).toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('banco fora: mantém a última política conhecida (fail-open, sem esquecer o bloqueio)', async () => {
    await service.policyFor('ios');
    findMany.mockRejectedValue(new Error('banco fora'));
    now.mockReturnValue(1_000_000 + 60_000);

    expect((await service.policyFor('ios'))?.minVersion).toEqual(v('2.10.0'));
    // E não martela o banco a cada requisição enquanto ele está fora: o valor antigo vale mais um ciclo
    await service.policyFor('ios');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('banco fora sem nenhuma política lida antes: tudo passa (nunca bloqueia todos os apps)', async () => {
    findMany.mockRejectedValue(new Error('banco fora'));
    expect(await service.policyFor('ios')).toBeUndefined();
  });
});

describe('VersionGateMiddleware', () => {
  const policyFor = jest.fn();
  const gate = new VersionGateMiddleware({
    policyFor,
  } as unknown as VersionPolicyService);

  const run = async (url: string, platform?: string, version?: string) => {
    const req = {
      url,
      appClient: resolveClientInfo(platform, version),
    } as unknown as Request & RequestWithClient;
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
      },
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
    };
    const next = jest.fn();
    gate.use(req, res as unknown as Response, next as NextFunction);
    await new Promise((resolve) => setImmediate(resolve));
    return { res, next };
  };

  beforeEach(() =>
    policyFor.mockReset().mockResolvedValue(policy('2.10.0', '2.12.0')),
  );

  it('abaixo da mínima: 426 com o code estável e a minVersion; não chama o próximo', async () => {
    const { res, next } = await run('/auth/login', 'android', '2.9.0');

    expect(res.statusCode).toBe(426);
    expect(res.body).toEqual({
      statusCode: 426,
      error: 'Upgrade Required',
      code: APP_UPDATE_REQUIRED,
      message: expect.any(String),
      platform: 'android',
      minVersion: '2.10.0',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('abaixo da recomendada: segue, com os headers do aviso', async () => {
    const { res, next } = await run('/projects', 'ios', '2.11.0');

    expect(next).toHaveBeenCalledWith();
    expect(res.headers).toEqual({
      'X-App-Update': 'recommended',
      'X-App-Recommended-Version': '2.12.0',
    });
  });

  it('probe de health: nem consulta a política', async () => {
    const { next } = await run('/health/ready', 'ios', '1.0.0');
    expect(next).toHaveBeenCalledWith();
    expect(policyFor).not.toHaveBeenCalled();
  });

  it('erro inesperado vai para o Express (next(err)), não é engolido', async () => {
    const boom = new Error('bug');
    policyFor.mockRejectedValue(boom);
    const { next } = await run('/', 'ios', '1.0.0');
    expect(next).toHaveBeenCalledWith(boom);
  });
});
