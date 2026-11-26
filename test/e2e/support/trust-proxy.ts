/**
 * Auxiliares das suítes de `TRUST_PROXY_HOPS` (o IP do cliente atrás de um proxy, Módulo 02, 2.5).
 *
 * Uma suíte por configuração (`trust-proxy.e2e-spec.ts` com 1, `trust-proxy-off.e2e-spec.ts` com 0): o `startE2EApp`
 * carrega o AppModule com `require`, e o Jest guarda o módulo em cache dentro de cada arquivo. Duas apps no mesmo
 * arquivo dividiriam o ConfigModule já validado com o valor da primeira; e o `jest.resetModules()` duplicaria as
 * classes do `@nestjs/*`, quebrando a injeção de dependência (os dois tentados).
 *
 * O alvo é o cadastro (3 por minuto por IP) com corpo vazio: o guard do rate limit roda ANTES da validação, então o
 * 400 conta. Os IPs são da faixa reservada para documentação (RFC 5737).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { E2EContext, startE2EApp } from './e2e-app';

export const CLIENT_A = '203.0.113.10';
export const CLIENT_B = '203.0.113.20';
export const FORGED = '198.51.100.99';

/** Um cadastro com o X-Forwarded-For dado: 400 se passar do rate limit (corpo vazio), 429 se não passar. */
export async function register(app: INestApplication, forwardedFor: string): Promise<number> {
  const response = await request(app.getHttpServer()).post('/auth/register').set('X-Forwarded-For', forwardedFor);
  return response.status;
}

/** Gasta o limite do cadastro (3 por minuto) com o X-Forwarded-For dado: os status das 4 chamadas. */
export async function exhaust(app: INestApplication, forwardedFor: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push(await register(app, forwardedFor));
  return statuses;
}

/**
 * Sobe a app com o rate limit LIGADO (o `test/setup.ts` o desliga para os outros E2E) e o número de proxies dado.
 * Devolve também a função que restaura o ambiente: com `--runInBand`, o `process.env` é compartilhado entre arquivos.
 */
export async function startWithTrustProxy(
  trustProxyHops: string,
): Promise<{ ctx: E2EContext; restoreEnv: () => void }> {
  const original = { throttle: process.env.DISABLE_THROTTLE, hops: process.env.TRUST_PROXY_HOPS };
  process.env.DISABLE_THROTTLE = 'false';
  process.env.TRUST_PROXY_HOPS = trustProxyHops;

  const restoreEnv = () => {
    process.env.DISABLE_THROTTLE = original.throttle;
    if (original.hops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = original.hops;
  };

  return { ctx: await startE2EApp(), restoreEnv };
}
