/**
 * `GET /projects/:projectId/stats` via HTTP, dono × intruso — Módulo 13.6a.
 *
 * Quem calcula os números é o consumer `reports`, que não roda nos E2E: aqui a linha de `project_stats` é gravada
 * direto no banco, e a suíte protege o lado da API, que é onde mora a segurança e a forma da resposta:
 * - 401 sem token; 400 para `projectId` que não é UUID v4;
 * - projeto de OUTRO usuário = 404, igual a inexistente (anti-enumeração, OWASP A01);
 * - projeto sem nenhum evento processado = zeros e `asOf: null` (o projeto existe; só não há o que contar);
 * - lead time médio = soma / concluídas, e `null` sem concluídas.
 *
 * O caminho completo (API → outbox → relay → Kafka → consumer → stats) está na suíte `test:streaming`.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  E2EContext,
  TestUser,
  registerAndLogin,
  resetDatabase,
  startE2EApp,
} from './support/e2e-app';

describe('Project stats (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;
  let ana: TestUser;
  let bia: TestUser;
  let projectId: string;

  const http = () => request(app.getHttpServer());
  const statsOf = (id: string, user: TestUser) =>
    http().get(`/projects/${id}/stats`).set(user.auth);

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ana = await registerAndLogin(app, 'Ana');
    bia = await registerAndLogin(app, 'Bia');
    projectId = (
      await http()
        .post('/projects')
        .set(ana.auth)
        .send({ name: 'Conciliação' })
        .expect(201)
    ).body.id as string;
  });

  it('deve exigir token: 401', async () => {
    await http().get(`/projects/${projectId}/stats`).expect(401);
  });

  it('projectId que não é UUID v4: 400', async () => {
    await statsOf('abc', ana).expect(400);
  });

  it('projeto de OUTRO usuário e projeto inexistente: o mesmo 404', async () => {
    await statsOf(projectId, bia).expect(404);
    await statsOf(randomUUID(), ana).expect(404);
  });

  it('projeto sem nenhum evento processado: zeros e asOf null', async () => {
    const { body } = await statsOf(projectId, ana).expect(200);

    expect(body).toEqual({
      projectId,
      total: 0,
      byStatus: { pending: 0, inProgress: 0, done: 0 },
      unassignedOpen: 0,
      avgLeadTimeSeconds: null,
      asOf: null,
    });
  });

  it('números do consumer: lead time médio = soma / concluídas, asOf = último evento', async () => {
    await ctx.prisma.projectStats.create({
      data: {
        projectId,
        total: 6,
        pending: 2,
        inProgress: 1,
        done: 3,
        unassignedOpen: 1,
        leadTimeSecondsSum: 3 * 3_600 + 1, // média 3_600,33 s → arredondada
        lastEventAt: new Date('2026-11-10T18:30:02.377Z'),
      },
    });

    const { body } = await statsOf(projectId, ana).expect(200);

    expect(body).toEqual({
      projectId,
      total: 6,
      byStatus: { pending: 2, inProgress: 1, done: 3 },
      unassignedOpen: 1,
      avgLeadTimeSeconds: 3_600,
      asOf: '2026-11-10T18:30:02.377Z',
    });
  });
});
