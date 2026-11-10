/**
 * `GET /me/notifications` via HTTP, com dois usuários — Módulo 13.4.
 *
 * Quem grava as notificações é o consumer do Kafka, que não roda nos E2E: aqui elas são inseridas direto no banco,
 * e a suíte protege o lado da API, que é onde mora a segurança:
 * - 401 sem token; 400 para `limit`/`cursor` inválidos;
 * - cada usuário vê SÓ as próprias notificações (o filtro vem do JWT; não há id de usuário na URL para trocar);
 * - paginação por cursor sem repetição nem buracos.
 *
 * O caminho completo (evento → relay → Kafka → consumer → notificação) está na suíte `test:streaming`.
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

describe('Notifications (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;
  let ana: TestUser;
  let bia: TestUser;

  const http = () => request(app.getHttpServer());

  /** Simula o que o consumer grava */
  const notify = async (userId: string, count: number) => {
    for (let i = 0; i < count; i++) {
      await ctx.prisma.notification.create({
        data: {
          userId,
          type: 'TASK_ASSIGNED',
          taskId: randomUUID(),
          projectId: randomUUID(),
          message: `Notificação ${i + 1}`,
          eventId: randomUUID(),
          createdAt: new Date(Date.UTC(2026, 10, 10, 12, 0, i)), // instantes distintos: ordem determinística
        },
      });
    }
  };

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
  });

  it('deve exigir token: 401', async () => {
    await http().get('/me/notifications').expect(401);
  });

  it.each([
    ['limit acima de 100', '?limit=101'],
    ['cursor que não é UUID', '?cursor=abc'],
  ])('deve validar a query: 400 para %s', async (_caso, query) => {
    await http().get(`/me/notifications${query}`).set(ana.auth).expect(400);
  });

  it('cada usuário vê SÓ as próprias notificações, mais recentes primeiro', async () => {
    await notify(ana.userId, 2);
    await notify(bia.userId, 1);

    const deAna = await http()
      .get('/me/notifications')
      .set(ana.auth)
      .expect(200);
    const deBia = await http()
      .get('/me/notifications')
      .set(bia.auth)
      .expect(200);

    expect(deAna.body.items.map((n: { message: string }) => n.message)).toEqual(
      ['Notificação 2', 'Notificação 1'],
    );
    expect(
      deAna.body.items.every(
        (n: { userId: string }) => n.userId === ana.userId,
      ),
    ).toBe(true);
    expect(deBia.body.items).toHaveLength(1);
    expect(deBia.body.items[0].userId).toBe(bia.userId);
  });

  it('paginação por cursor: páginas sem repetição nem buracos', async () => {
    await notify(ana.userId, 5);

    const first = await http()
      .get('/me/notifications?limit=2')
      .set(ana.auth)
      .expect(200);
    const second = await http()
      .get(`/me/notifications?limit=2&cursor=${first.body.nextCursor}`)
      .set(ana.auth)
      .expect(200);
    const third = await http()
      .get(`/me/notifications?limit=2&cursor=${second.body.nextCursor}`)
      .set(ana.auth)
      .expect(200);

    const messages = [first, second, third].flatMap((page) =>
      page.body.items.map((n: { message: string }) => n.message),
    );
    expect(messages).toEqual([5, 4, 3, 2, 1].map((i) => `Notificação ${i}`));
    expect(third.body.nextCursor).toBeNull();
  });
});
