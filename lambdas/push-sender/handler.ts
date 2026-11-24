/*
 * Ponto de entrada da Lambda `push-sender` (Módulo 13.7): consome a fila `taskflow-push` em lotes e envia cada push
 * uma vez. Este arquivo só MONTA as dependências a partir do ambiente; a lógica está no `batch-processor.ts`, testado
 * sem AWS.
 *
 * Montado fora do handler, de propósito: o que fica no escopo do módulo sobrevive entre invocações do mesmo ambiente
 * de execução (*warm start*), e o cliente do DynamoDB reaproveita as conexões. Criá-lo dentro do handler pagaria o
 * handshake TLS em toda invocação.
 *
 * Logs: uma linha JSON por evento, pelo `console`. Na Lambda, o stdout é o caminho do log até o CloudWatch, e uma
 * biblioteca como o pino exigiria empacotar dependências; a API e os workers continuam no `nestjs-pino`.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createBatchProcessor, type Logger } from './batch-processor';
import { DynamoIdempotencyStore } from './idempotency';
import { SimulatedPushProvider } from './push-provider';

/** Lê um inteiro positivo do ambiente; sem valor, usa o padrão. Valor inválido derruba o cold start, com a causa. */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} precisa ser um inteiro positivo (recebido: ${raw})`,
    );
  }
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`variável de ambiente ${name} ausente`);
  return value;
}

const line =
  (level: 'info' | 'error') =>
  (message: string, fields: object = {}): void => {
    const entry = JSON.stringify({ level, message, ...fields });
    if (level === 'error') console.error(entry);
    else console.log(entry);
  };

const logger: Logger = { info: line('info'), error: line('error') };

// Endpoint e credenciais: o runtime da Lambda injeta (na AWS, a role; no LocalStack, AWS_ENDPOINT_URL também)
const store = new DynamoIdempotencyStore(new DynamoDBClient({}), {
  tableName: required('IDEMPOTENCY_TABLE'),
  leaseSeconds: positiveInt('LEASE_SECONDS', 30),
  retentionSeconds: positiveInt('RETENTION_HOURS', 48) * 3600,
});

export const handler = createBatchProcessor({
  store,
  provider: new SimulatedPushProvider((message, fields) =>
    logger.info(message, fields),
  ),
  logger,
});
