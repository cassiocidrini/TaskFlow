/**
 * Peças do health check e do graceful shutdown, isoladas (sem Nest, sem banco).
 *
 * Protege: o `ShutdownState` só passa a "drenando" quando o encerramento começa e espera a janela configurada; o
 * indicador do banco diz `down` sem expor a mensagem do driver (o `/health/ready` é público, OWASP A05), inclusive
 * quando o banco TRAVA em vez de recusar; `Connection: close` só durante a drenagem; e o hook do OpenTelemetry
 * chama o shutdown registrado e nunca impede o processo de terminar. (Sem registro, o hook não faz nada: é o que
 * acontece em todo `close()` dos E2E, onde o `tracing.ts` não é carregado.)
 *
 * A ordem real do `app.close()` (HTTP fecha antes do Prisma) é provada em `integration/graceful-shutdown.spec.ts`.
 */
import { HealthIndicatorService } from '@nestjs/terminus';
import type { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { registerTelemetryShutdown } from '../../src/common/lifecycle/telemetry-registry';
import { TelemetryShutdownHook } from '../../src/common/lifecycle/telemetry-shutdown';
import type { Env } from '../../src/config/env.schema';
import { DatabaseHealthIndicator } from '../../src/health/database.health';
import { DrainingConnectionMiddleware } from '../../src/health/draining-connection.middleware';
import { ShutdownState } from '../../src/health/shutdown-state';
import type { PrismaService } from '../../src/prisma/prisma.service';

const configWithDrain = (drainMs: number) =>
  ({ get: () => drainMs }) as unknown as ConfigService<Env, true>;

describe('ShutdownState', () => {
  it('não deve estar drenando antes do encerramento', () => {
    expect(new ShutdownState(configWithDrain(0)).isDraining()).toBe(false);
  });

  it('deve marcar drenando e esperar a janela configurada antes de liberar o fechamento do HTTP', async () => {
    const state = new ShutdownState(configWithDrain(60));
    const start = Date.now();

    await state.beforeApplicationShutdown('SIGTERM');

    expect(state.isDraining()).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });
});

describe('DatabaseHealthIndicator', () => {
  const indicatorWith = (queryRaw: jest.Mock) =>
    new DatabaseHealthIndicator({ $queryRaw: queryRaw } as unknown as PrismaService, new HealthIndicatorService());

  it('deve reportar up quando o SELECT 1 responde', async () => {
    const result = await indicatorWith(jest.fn().mockResolvedValue([{ '?column?': 1 }])).pingCheck('database');

    expect(result).toEqual({ database: { status: 'up' } });
  });

  it('deve reportar down SEM a mensagem do driver quando o banco recusa', async () => {
    const queryRaw = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.3.7:5432'));

    const result = await indicatorWith(queryRaw).pingCheck('database');

    expect(result).toEqual({ database: { status: 'down' } });
    expect(JSON.stringify(result)).not.toContain('10.0.3.7');
  });

  it('deve reportar down quando o banco TRAVA (timeout), em vez de pendurar o probe', async () => {
    const queryRaw = jest.fn().mockReturnValue(new Promise(() => {})); // nunca responde

    const result = await indicatorWith(queryRaw).pingCheck('database', 30);

    expect(result).toEqual({ database: { status: 'down' } });
  });
});

describe('DrainingConnectionMiddleware', () => {
  const run = (draining: boolean) => {
    const res = { setHeader: jest.fn() };
    const next = jest.fn() as NextFunction;
    const shutdown = { isDraining: () => draining } as ShutdownState;
    new DrainingConnectionMiddleware(shutdown).use({} as Request, res as unknown as Response, next);
    return { res, next };
  };

  it('deve mandar Connection: close durante a drenagem', () => {
    const { res, next } = run(true);

    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close');
    expect(next).toHaveBeenCalled();
  });

  it('NÃO deve mexer na conexão em operação normal (keep-alive continua)', () => {
    const { res, next } = run(false);

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

describe('TelemetryShutdownHook', () => {
  it('deve chamar o shutdown registrado pelo tracing.ts', async () => {
    const shutdown = jest.fn().mockResolvedValue(undefined);
    registerTelemetryShutdown(shutdown);

    await new TelemetryShutdownHook().onApplicationShutdown();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('NÃO deve lançar se o envio final da telemetria falhar (o processo precisa terminar)', async () => {
    registerTelemetryShutdown(jest.fn().mockRejectedValue(new Error('Jaeger fora do ar')));

    await expect(new TelemetryShutdownHook().onApplicationShutdown()).resolves.toBeUndefined();
  });
});
