/**
 * A flag `task-list-with-stats` na listagem de tarefas, via HTTP (Módulo 14.7).
 *
 * Protege o comportamento atrás da flag:
 * - quem está na flag recebe `stats` na PRIMEIRA página, e não nas seguintes (o app pede o resumo uma vez);
 * - quem está fora da flag recebe a listagem de sempre, sem `stats`;
 * - o kill switch tira o `stats` na resposta seguinte, sem reiniciar a API.
 *
 * Os números vêm do read model do consumer `reports`, que não roda no E2E: aqui eles vêm zerados, com `asOf: null`. O que
 * o teste confere é o que a flag controla, a PRESENÇA do campo. Os números em si são testados no Módulo 13.6a.
 */
import { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  E2EContext,
  eventually,
  registerAndLogin,
  resetDatabase,
  startE2EApp,
  type TestUser,
} from './support/e2e-app';

describe('Listagem com stats atrás da flag task-list-with-stats (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;
  let prisma: PrismaClient;
  let inFlag: TestUser;
  let outOfFlag: TestUser;
  let projectInFlag: string;
  let projectOutOfFlag: string;

  const http = () => request(app.getHttpServer());

  const projectWithTwoTasks = async (user: TestUser) => {
    const projectId = (
      await http()
        .post('/projects')
        .set(user.auth)
        .send({ name: 'Com números' })
        .expect(201)
    ).body.id as string;
    for (const title of ['Tarefa 1', 'Tarefa 2']) {
      await http()
        .post(`/projects/${projectId}/tasks`)
        .set(user.auth)
        .send({ title })
        .expect(201);
    }
    // A projeção roda depois da resposta: espera as duas aparecerem
    await eventually(async () => {
      const res = await http()
        .get(`/projects/${projectId}/tasks`)
        .set(user.auth)
        .expect(200);
      expect(res.body.items).toHaveLength(2);
    });
    return projectId;
  };

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
    prisma = ctx.prisma;
    await resetDatabase(prisma);
    inFlag = await registerAndLogin(app, 'Na flag');
    outOfFlag = await registerAndLogin(app, 'Fora da flag');
    projectInFlag = await projectWithTwoTasks(inFlag);
    projectOutOfFlag = await projectWithTwoTasks(outOfFlag);
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "feature_flags"');
    // Ligada só para um usuário (a lista de usuários), com 0% para o resto
    await prisma.featureFlag.create({
      data: {
        key: 'task-list-with-stats',
        description: 'Números do projeto na listagem',
        enabled: true,
        rolloutPercentage: 0,
        allowUserIds: [inFlag.userId],
        updatedBy: 'e2e',
      },
    });
  });

  it('na flag: stats na primeira página, e não na seguinte', async () => {
    const first = await http()
      .get(`/projects/${projectInFlag}/tasks?limit=1`)
      .set(inFlag.auth)
      .expect(200);

    expect(first.body.stats).toMatchObject({
      projectId: projectInFlag,
      byStatus: expect.any(Object),
    });
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const next = await http()
      .get(
        `/projects/${projectInFlag}/tasks?limit=1&cursor=${first.body.nextCursor as string}`,
      )
      .set(inFlag.auth)
      .expect(200);
    expect(next.body).not.toHaveProperty('stats');
    expect(next.body.items).toHaveLength(1);
  });

  it('fora da flag: a listagem de sempre, sem stats', async () => {
    const res = await http()
      .get(`/projects/${projectOutOfFlag}/tasks`)
      .set(outOfFlag.auth)
      .expect(200);

    expect(res.body).not.toHaveProperty('stats');
    expect(res.body.items).toHaveLength(2);
  });

  it('kill switch: o stats some na resposta seguinte, sem reiniciar a API', async () => {
    const url = `/projects/${projectInFlag}/tasks`;
    expect(
      (await http().get(url).set(inFlag.auth).expect(200)).body,
    ).toHaveProperty('stats');

    await prisma.featureFlag.update({
      where: { key: 'task-list-with-stats' },
      data: { enabled: false },
    });

    expect(
      (await http().get(url).set(inFlag.auth).expect(200)).body,
    ).not.toHaveProperty('stats');
  });
});
