/**
 * O IP do cliente SEM proxy confiável, com `TRUST_PROXY_HOPS=0` (o padrão; desenvolvimento e testes).
 *
 * Protege: sem proxy na frente, o X-Forwarded-For é só um header que o cliente escolhe, e a app não pode acreditar
 * nele. A chave do rate limit é o IP da conexão, e trocar o header não dá um limite novo. Se o padrão virasse
 * "confiar", qualquer cliente fugiria do limite mandando um IP diferente a cada requisição. O caso com proxy (1) está
 * em `trust-proxy.e2e-spec.ts`, e o porquê de um arquivo por configuração, em `support/trust-proxy.ts`.
 */
import { E2EContext } from './support/e2e-app';
import { CLIENT_A, CLIENT_B, exhaust, register, startWithTrustProxy } from './support/trust-proxy';

describe('IP do cliente sem proxy: TRUST_PROXY_HOPS=0 (e2e)', () => {
  let ctx: E2EContext;
  let restoreEnv: () => void;

  beforeAll(async () => {
    ({ ctx, restoreEnv } = await startWithTrustProxy('0'));
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
    restoreEnv?.();
  });

  it('o X-Forwarded-For é ignorado: trocar o header não muda o limite', async () => {
    expect(await exhaust(ctx.app, CLIENT_A)).toEqual([400, 400, 400, 429]);

    expect(await register(ctx.app, CLIENT_B)).toBe(429);
  });
});
