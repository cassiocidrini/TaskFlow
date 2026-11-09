import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Env } from '../config/env.schema';

/**
 * Estado de encerramento da réplica: o primeiro passo do graceful shutdown.
 *
 * Ordem do `app.close()` no Nest: `onModuleDestroy` → `beforeApplicationShutdown` → fecha o HTTP →
 * `onApplicationShutdown`. Este hook roda no 2º passo, quando o servidor AINDA aceita requisições:
 * 1. marca `draining`, e o `/health/ready` passa a responder 503;
 * 2. espera `SHUTDOWN_DRAIN_MS` enquanto continua atendendo normalmente.
 *
 * Por que esperar: num orquestrador (Kubernetes, ECS), o SIGTERM e a remoção da réplica do balanceador acontecem
 * em PARALELO. Se o HTTP fechasse na hora, as requisições roteadas nesse meio-tempo levariam "connection refused".
 * A janela dá tempo para o balanceador ver o 503 do readiness (ou propagar a remoção) e parar de mandar tráfego.
 *
 * Por que não a opção `gracefulShutdownTimeoutMs` do terminus: ela só espera, sem fazer o readiness falhar, e o
 * balanceador continuaria mandando tráfego durante a espera.
 */
@Injectable()
export class ShutdownState implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownState.name);
  private draining = false;

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** `true` a partir do início do encerramento: a réplica não deve mais receber tráfego novo. */
  isDraining(): boolean {
    return this.draining;
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.draining = true;
    const drainMs = this.config.get('SHUTDOWN_DRAIN_MS', { infer: true });
    this.logger.log(`Encerramento iniciado (${signal ?? 'app.close'}): readiness = 503, drenando por ${drainMs} ms`);
    if (drainMs > 0) {
      await sleep(drainMs);
    }
  }
}
