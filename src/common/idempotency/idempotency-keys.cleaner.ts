import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';

const CLEANUP_CHUNK = 5_000;
const CLEANUP_EVERY_MS = 60 * 60_000;

/**
 * Apaga as chaves de idempotência vencidas (Módulo 14.5), em lotes, a cada hora. O mesmo padrão da limpeza do
 * `processed_events` (Módulo 13.6c): lotes de 5 mil (sem uma transação gigante nem lock longo), uma rodada por vez e
 * falha só registrada (a próxima rodada tenta de novo).
 *
 * Roda em toda réplica da API: duas apagando ao mesmo tempo só disputam linhas, e o `DELETE` de uma linha já apagada não
 * faz nada. Sem a limpeza, a correção não muda (a busca ignora vencidas); só a tabela cresceria para sempre.
 */
@Injectable()
export class IdempotencyKeysCleaner
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(IdempotencyKeysCleaner.name);
  private readonly ttlHours: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlHours = config.get('IDEMPOTENCY_KEY_TTL_HOURS', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.runOnce(), CLEANUP_EVERY_MS);
    // Não segura o processo vivo: quem decide o encerramento é o ciclo de vida do Nest
    this.timer.unref();
  }

  /** Antes de o Prisma fechar: espera uma rodada em andamento. */
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  async cleanup(): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM idempotency_keys WHERE (user_id, key) IN (
          SELECT user_id, key FROM idempotency_keys
          WHERE created_at < (now() AT TIME ZONE 'UTC') - make_interval(hours => ${this.ttlHours}::int)
          LIMIT ${CLEANUP_CHUNK}
        )`;
      total += deleted;
      if (deleted < CLEANUP_CHUNK) return total;
    }
  }

  private async runOnce(): Promise<void> {
    if (this.running) return; // uma rodada lenta não empilha outra
    this.running = this.cleanup();
    try {
      const deleted = await this.running;
      if (deleted > 0) {
        this.logger.log(
          `Limpeza: ${deleted} chave(s) de idempotência com mais de ${this.ttlHours} h removida(s)`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Limpeza das chaves de idempotência falhou (tenta de novo em 1 h): ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = undefined;
    }
  }
}
