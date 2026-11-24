import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

/**
 * Resultado de tentar reservar um push:
 * - `acquired`: esta invocação ganhou o direito de enviar;
 * - `completed`: já foi enviado (duplicata): a mensagem sai da fila sem enviar de novo;
 * - `in-progress`: outra invocação está enviando agora (prazo ainda válido): devolver à fila e tentar depois.
 */
export type BeginResult = 'acquired' | 'completed' | 'in-progress';

/** Porta da idempotência: o processamento do lote é testado com uma versão em memória, sem DynamoDB. */
export interface IdempotencyStore {
  begin(pushId: string): Promise<BeginResult>;
  complete(pushId: string): Promise<void>;
  /** Desfaz a reserva depois de um envio que falhou, para a próxima tentativa não esperar o prazo vencer. */
  release(pushId: string): Promise<void>;
}

export interface DynamoIdempotencyOptions {
  tableName: string;
  /**
   * Por quanto tempo uma reserva `IN_PROGRESS` vale. Precisa ser MAIOR que o timeout da Lambda (uma invocação viva
   * nunca perde a reserva para outra) e MENOR que o visibility timeout da fila (quando a mensagem de uma invocação
   * que morreu voltar, a reserva já venceu e o envio é refeito). Terraform: Lambda 10 s < prazo 30 s < fila 60 s.
   */
  leaseSeconds: number;
  /** Por quanto tempo o `COMPLETED` é lembrado (TTL do DynamoDB). Maior que a retenção da fila, que reentrega. */
  retentionSeconds: number;
  now?: () => number;
}

/**
 * Idempotência do envio no DynamoDB, com estado "em andamento" (o padrão do Powertools for AWS Lambda,
 * reimplementado). Por que não um "já enviei?" simples:
 * - marcar ANTES de enviar e o envio falhar → marcado e nunca enviado (push perdido);
 * - marcar DEPOIS de enviar → duas invocações simultâneas da mesma mensagem enviam as duas.
 * A reserva com prazo resolve as duas: um `PutItem` CONDICIONAL só grava se o registro não existe ou se é uma
 * reserva vencida (a invocação que a fez morreu). O DynamoDB avalia a condição atomicamente, como o `ON CONFLICT`
 * do `processed_events` no Postgres.
 *
 * Itens: `pushId` (chave), `status`, `leaseUntil` e `expiresAt` (epoch em SEGUNDOS: é o formato que o TTL lê).
 */
export class DynamoIdempotencyStore implements IdempotencyStore {
  private readonly now: () => number;

  constructor(
    private readonly client: DynamoDBClient,
    private readonly options: DynamoIdempotencyOptions,
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async begin(pushId: string): Promise<BeginResult> {
    const now = this.now();
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.options.tableName,
          Item: {
            pushId: { S: pushId },
            status: { S: 'IN_PROGRESS' },
            leaseUntil: { N: String(now + this.options.leaseSeconds) },
            expiresAt: { N: String(now + this.options.retentionSeconds) },
          },
          ConditionExpression:
            'attribute_not_exists(pushId) OR (#status = :inProgress AND leaseUntil < :now)',
          ExpressionAttributeNames: { '#status': 'status' }, // `status` é palavra reservada do DynamoDB
          ExpressionAttributeValues: {
            ':inProgress': { S: 'IN_PROGRESS' },
            ':now': { N: String(now) },
          },
        }),
      );
      return 'acquired';
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
    // A condição falhou: existe um registro que não é uma reserva vencida. Qual dos dois?
    const { Item } = await this.client.send(
      new GetItemCommand({
        TableName: this.options.tableName,
        Key: { pushId: { S: pushId } },
        ConsistentRead: true, // leitura eventual poderia não ver o registro que acabou de barrar o put
      }),
    );
    return Item?.status?.S === 'COMPLETED' ? 'completed' : 'in-progress';
  }

  async complete(pushId: string): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.options.tableName,
        Key: { pushId: { S: pushId } },
        UpdateExpression: 'SET #status = :completed, expiresAt = :expiresAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':completed': { S: 'COMPLETED' },
          ':expiresAt': {
            N: String(this.now() + this.options.retentionSeconds),
          },
        },
      }),
    );
  }

  async release(pushId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.options.tableName,
          Key: { pushId: { S: pushId } },
          // Só a própria reserva: nunca apagar um COMPLETED (reabriria a porta para a duplicata)
          ConditionExpression: '#status = :inProgress',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':inProgress': { S: 'IN_PROGRESS' } },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }
}
