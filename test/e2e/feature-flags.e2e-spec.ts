/**
 * `GET /me/features` via HTTP, com a MESMA configuração da produção (`configureApp`) — Módulo 14.6.
 *
 * Protege o contrato que o app usa ao abrir:
 * - só o RESULTADO por flag (`true`/`false`), nunca a regra (porcentagem, lista de usuários, restrições);
 * - a avaliação é por usuário (lista de testadores) e por app (plataforma e versão dos headers da 14.1);
 * - o kill switch vale na resposta seguinte, sem reiniciar a API (aqui, cache desligado; em produção, até 5 s);
 * - exige token (401) e não é guardado em cache compartilhado (`Cache-Control: private`).
 */
import { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  E2EContext,
  registerAndLogin,
  resetDatabase,
  startE2EApp,
  type TestUser,
} from './support/e2e-app';

describe('GET /me/features (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;
  let prisma: PrismaClient;
  let tester: TestUser;
  let regular: TestUser;

  const http = () => request(app.getHttpServer());
  const iosNew = { 'X-Platform': 'ios', 'X-App-Version': '2.15.0' };

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
    prisma = ctx.prisma;
    await resetDatabase(prisma);
    tester = await registerAndLogin(app, 'Testadora');
    regular = await registerAndLogin(app, 'Usuário comum');
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "feature_flags"');
    await prisma.featureFlag.createMany({
      data: [
        // Só para a lista de testadores, no mobile a partir da 2.15
        {
          key: 'tela-nova',
          description: 'Tela nova',
          enabled: true,
          rolloutPercentage: 0,
          allowUserIds: [tester.userId],
          platforms: ['ios', 'android'],
          minAppVersion: '2.15.0',
          updatedBy: 'e2e',
        },
        {
          key: 'para-todos',
          description: 'Ligada',
          enabled: true,
          rolloutPercentage: 100,
          updatedBy: 'e2e',
        },
      ],
    });
  });

  const features = (user: TestUser, headers: Record<string, string> = iosNew) =>
    http().get('/me/features').set(user.auth).set(headers).expect(200);

  it('só o resultado por flag, nunca a regra', async () => {
    const res = await features(tester);

    expect(res.body).toEqual({
      flags: { 'para-todos': true, 'tela-nova': true },
    });
    expect(JSON.stringify(res.body)).not.toContain(tester.userId); // a lista de testadores não vaza
    expect(res.headers['cache-control']).toBe('private, no-cache');
  });

  it('por usuário e por app: fora da lista, na web ou no app antigo, a tela nova fica desligada', async () => {
    expect((await features(regular)).body.flags['tela-nova']).toBe(false);
    expect(
      (
        await features(tester, {
          'X-Platform': 'web',
          'X-App-Version': '2.15.0',
        })
      ).body.flags['tela-nova'],
    ).toBe(false);
    expect(
      (
        await features(tester, {
          'X-Platform': 'ios',
          'X-App-Version': '2.14.0',
        })
      ).body.flags['tela-nova'],
    ).toBe(false);
  });

  it('kill switch: desligada na resposta seguinte, sem reiniciar a API (vence a lista de usuários)', async () => {
    expect((await features(tester)).body.flags['tela-nova']).toBe(true);

    await prisma.featureFlag.update({
      where: { key: 'tela-nova' },
      data: { enabled: false },
    });

    expect((await features(tester)).body.flags['tela-nova']).toBe(false);
  });

  it('sem token: 401', async () => {
    await http().get('/me/features').expect(401);
  });
});
