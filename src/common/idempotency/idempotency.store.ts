import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { metrics } from '@opentelemetry/api';
import type { Prisma } from '@prisma/client';
import type { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { IdempotencyKeyReusedError } from './idempotency-key';

/** A requisição com chave, como o handler a recebe. */
export interface IdempotencyRequest {
  userId: string;
  key: string;
  requestHash: string;
}

/** A resposta guardada da 1ª execução. */
export interface StoredResponse {
  status: number;
  body: Prisma.JsonValue;
}

type Outcome = 'created' | 'replayed' | 'reused';

/**
 * As chaves de idempotência (Módulo 14.5): busca a resposta guardada e monta a gravação que vai NA TRANSAÇÃO do efeito.
 *
 * **Por que na mesma transação, e não "reservar → executar → marcar":** a reserva separada é o dual-write do Módulo 13
 * de novo. Um crash entre criar a tarefa e marcar a chave a deixaria presa em "em andamento"; com prazo de validade na
 * reserva, a tentativa seguinte criaria uma SEGUNDA tarefa. Aqui, a linha da chave é mais um INSERT da transação do
 * `TaskCreated` (o gancho `alsoWrite` do Event Store): ou a tarefa existe e a chave está registrada, ou nenhuma das
 * duas. Sem estado intermediário, sem prazo de reserva. É o `processed_events` (13.4) do lado HTTP.
 *
 * **Concorrência:** duas tentativas simultâneas com a mesma chave passam pela busca (nenhuma acha nada) e tentam
 * gravar. A chave primária `(user_id, key)` deixa uma só; a outra transação é desfeita inteira (a tarefa dela não
 * existe) e quem chamou busca de novo e devolve a resposta da vencedora.
 *
 * **Validade:** `IDEMPOTENCY_KEY_TTL_HOURS` (24 h, como no Stripe). Chave vencida conta como nova: a busca a ignora, e a
 * gravação apaga a vencida antes de inserir. O job de limpeza tira o resto da tabela.
 */
@Injectable()
export class IdempotencyStore {
  private readonly ttlMs: number;
  private readonly requests = metrics
    .getMeter('taskflow-api')
    .createCounter('taskflow_idempotency_requests', {
      description:
        'Requisições com Idempotency-Key, por desfecho: created (1ª vez), replayed (repetida), reused (422, chave de outro pedido)',
    });

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs =
      config.get('IDEMPOTENCY_KEY_TTL_HOURS', { infer: true }) * 3_600_000;
  }

  /** A resposta guardada para esta chave do usuário, se ainda válida. */
  async find(
    userId: string,
    key: string,
  ): Promise<(StoredResponse & { requestHash: string }) | null> {
    const row = await this.prisma.idempotencyKey.findFirst({
      where: {
        userId,
        key,
        createdAt: { gt: new Date(Date.now() - this.ttlMs) },
      },
    });
    return row
      ? {
          status: row.responseStatus,
          body: row.responseBody,
          requestHash: row.requestHash,
        }
      : null;
  }

  /**
   * A resposta guardada, para devolver de novo. Pedido diferente com a mesma chave: 422 (`IdempotencyKeyReusedError`).
   */
  replay(
    stored: StoredResponse & { requestHash: string },
    request: IdempotencyRequest,
  ): StoredResponse {
    if (stored.requestHash !== request.requestHash) {
      this.count('reused');
      throw new IdempotencyKeyReusedError();
    }
    this.count('replayed');
    return { status: stored.status, body: stored.body };
  }

  /**
   * Os comandos que registram a chave, para o `alsoWrite` do Event Store: entram na transação do efeito. Apaga antes
   * uma chave VENCIDA igual (senão a chave primária barraria a reutilização legítima depois da validade).
   */
  writes(
    request: IdempotencyRequest,
    response: StoredResponse,
  ): Prisma.PrismaPromise<unknown>[] {
    return [
      this.prisma.idempotencyKey.deleteMany({
        where: {
          userId: request.userId,
          key: request.key,
          createdAt: { lte: new Date(Date.now() - this.ttlMs) },
        },
      }),
      this.prisma.idempotencyKey.create({
        data: {
          userId: request.userId,
          key: request.key,
          requestHash: request.requestHash,
          responseStatus: response.status,
          responseBody: response.body as Prisma.InputJsonValue,
        },
      }),
    ];
  }

  count(outcome: Outcome): void {
    this.requests.add(1, { outcome });
  }
}
