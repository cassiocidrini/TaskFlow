import { OnApplicationShutdown } from '@nestjs/common';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { InfrastructureError } from '../../../common/messaging/consumer-errors';
import { PushQueue, type PushRequest } from './push-queue';

/**
 * Orçamento de tempo do envio. O `SendMessage` roda DENTRO da transação do Prisma (timeout padrão de 5 s): o pior
 * caso precisa caber nela com folga, senão a transação expira (P2028) antes de o SDK desistir, e o erro que aparece
 * no log deixa de dizer "o SQS não respondeu". Pior caso: 2 tentativas × (1 s de conexão + 1,5 s de resposta) ≈ 5 s
 * só se as DUAS travarem na conexão E na resposta; o caso real de SQS fora é recusa de conexão, em milissegundos.
 */
const SQS_TIMEOUTS = {
  maxAttempts: 2,
  connectionTimeout: 1_000,
  requestTimeout: 1_500,
} as const;

export interface SqsPushQueueOptions {
  queueUrl: string;
  region: string;
  /** Só fora da AWS (LocalStack). Na AWS real fica vazio e o SDK resolve o endpoint pela região. */
  endpoint?: string;
}

/**
 * Adapter SQS da porta {@link PushQueue} (Módulo 13.7): "entregue o trabalho e só volte quando a fila confirmou".
 *
 * Credenciais pela cadeia padrão do SDK (variáveis `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` no dev com LocalStack;
 * role IAM do processo na AWS), nunca no código nem no schema de ambiente.
 *
 * Toda falha vira {@link InfrastructureError}: nenhum erro do `SendMessage` é culpa do evento (o corpo é pequeno e
 * montado por nós), então a partição espera a fila voltar em vez de mandar evento bom para o DLT.
 */
export class SqsPushQueue extends PushQueue implements OnApplicationShutdown {
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor(options: SqsPushQueueOptions, client?: SQSClient) {
    super();
    this.queueUrl = options.queueUrl;
    this.client =
      client ??
      new SQSClient({
        region: options.region,
        endpoint: options.endpoint,
        maxAttempts: SQS_TIMEOUTS.maxAttempts,
        requestHandler: {
          connectionTimeout: SQS_TIMEOUTS.connectionTimeout,
          requestTimeout: SQS_TIMEOUTS.requestTimeout,
        },
      });
  }

  async enqueue(request: PushRequest): Promise<void> {
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(request),
        }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new InfrastructureError(
        `SQS não confirmou o push ${request.pushId}: ${reason}`,
        { cause: error },
      );
    }
  }

  /** Fecha as conexões HTTP do SDK depois que o consumer parou (o último envio já terminou). */
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
