import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../prisma/prisma.service';

/** Acima disto o banco é considerado indisponível: um probe lento é um probe que falhou. */
export const DATABASE_PING_TIMEOUT_MS = 1_000;

/**
 * Indicador de saúde do PostgreSQL: `SELECT 1` com timeout.
 *
 * Por que um indicador próprio, e não o `PrismaHealthIndicator` do terminus: o de lá devolve a mensagem crua do
 * driver na resposta (ex.: `connect ECONNREFUSED 10.0.3.7:5432`), e o `/health/ready` é público. Endereço interno e
 * detalhe de infraestrutura não devem vazar (OWASP A05). Aqui a resposta diz só `up`/`down`; a causa vai para o log.
 */
@Injectable()
export class DatabaseHealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly health: HealthIndicatorService,
  ) {}

  /** @param timeoutMs só os testes mudam; em produção vale {@link DATABASE_PING_TIMEOUT_MS}. */
  async pingCheck(key: string, timeoutMs = DATABASE_PING_TIMEOUT_MS) {
    const indicator = this.health.check(key);
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        // ref: false — o timer não segura o processo vivo depois que o SELECT já respondeu
        sleep(timeoutMs, undefined, { ref: false }).then(() => {
          throw new Error(`sem resposta em ${timeoutMs} ms`);
        }),
      ]);
      return indicator.up();
    } catch (error) {
      this.logger.warn(`Readiness: banco indisponível (${error instanceof Error ? error.message : String(error)})`);
      return indicator.down();
    }
  }
}
