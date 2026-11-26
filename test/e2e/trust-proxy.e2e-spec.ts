/**
 * O IP do cliente atrás de um proxy, com `TRUST_PROXY_HOPS=1` (o Envoy do Gateway, Módulo 02, 2.5).
 *
 * Protege: atrás do Envoy, o IP da conexão é o do proxy, igual para todo cliente. Medido no cluster: um pod que nunca
 * tinha chamado o cadastro recebeu 429 porque OUTRO cliente gastou o limite. Com um salto confiável, o IP vem do
 * X-Forwarded-For e cada cliente tem o seu limite.
 *
 * O teste que mais importa é o da falsificação: só o ÚLTIMO salto do header é confiável (foi o proxy que escreveu); o
 * que vem antes pode ter sido mandado pelo próprio cliente. Com `trust proxy: true` no lugar do número, o cliente
 * escolheria o próprio IP a cada requisição e nunca seria limitado, e é esse teste que reprova. O padrão (0, header
 * ignorado) está em `trust-proxy-off.e2e-spec.ts`; os auxiliares, em `support/trust-proxy.ts`.
 */
import { E2EContext } from './support/e2e-app';
import { CLIENT_A, CLIENT_B, exhaust, FORGED, register, startWithTrustProxy } from './support/trust-proxy';

describe('IP do cliente atrás de um proxy: TRUST_PROXY_HOPS=1 (e2e)', () => {
  let ctx: E2EContext;
  let restoreEnv: () => void;

  beforeAll(async () => {
    ({ ctx, restoreEnv } = await startWithTrustProxy('1'));
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
    restoreEnv?.();
  });

  it('cada cliente tem o seu limite: o 429 de A não bloqueia B', async () => {
    expect(await exhaust(ctx.app, CLIENT_A)).toEqual([400, 400, 400, 429]);

    expect(await register(ctx.app, CLIENT_B)).toBe(400);
  });

  it('um IP forjado pelo cliente no começo do header não escapa do limite', async () => {
    // O cliente A manda um IP inventado; o proxy acrescenta o IP real de A no fim. Só o último salto vale
    expect(await register(ctx.app, `${FORGED}, ${CLIENT_A}`)).toBe(429);
  });
});
