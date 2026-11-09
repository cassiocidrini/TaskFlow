import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env.schema';

/**
 * O `PrismaClient` como provider do NestJS (injetável e, portanto, substituível por um mock nos testes).
 *
 * - **Driver adapter (`@prisma/adapter-pg`):** no Prisma 7, a conexão passa pelo driver `pg` nativo, sem o
 *   engine binário antigo — e o `pg` é instrumentado pelo OpenTelemetry, então cada query vira um span.
 * - **`DATABASE_URL` do `ConfigService`, e não `process.env.DATABASE_URL!`:** o `!` só calava o compilador;
 *   agora o valor foi validado no boot (precisa ser `postgres(ql)://`) e, sem ele, a app nem sobe.
 * - **SQL injection (OWASP A03):** o Prisma parametriza todas as consultas. O único SQL cru do projeto
 *   (`TRUNCATE` nos testes) é uma string constante.
 *
 * Lifecycle hooks: conecta no boot (falha cedo se o banco estiver fora) e desconecta no encerramento,
 * devolvendo as conexões do pool.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  /** Sem `private readonly`: numa classe derivada, parameter properties exigiriam `super()` antes do uso. */
  constructor(config: ConfigService<Env, true>) {
    const adapter = new PrismaPg({
      connectionString: config.get('DATABASE_URL', { infer: true }),
    });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  /**
   * Desconecta no ÚLTIMO passo do `app.close()`, depois de o servidor HTTP fechar.
   *
   * Antes era `onModuleDestroy`, o PRIMEIRO passo, com o HTTP ainda atendendo. Uma requisição em andamento não
   * falhava (o Prisma reconecta sozinho na próxima query), mas reabria o pool DEPOIS do disconnect, e essa conexão
   * só morria com o processo, sem encerramento limpo no Postgres. Desconectar depois do último uso possível fecha o
   * pool de verdade. O teste `graceful-shutdown.spec.ts` mede isso (1 conexão sobrando na ordem antiga, 0 na nova).
   */
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
