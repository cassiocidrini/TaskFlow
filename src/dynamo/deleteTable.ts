import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { TABLE_NAME } from './client';

const client = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

async function deleteTable(): Promise<void> {
  console.log(`[*] Deletando tabela "${TABLE_NAME}"...`);

  try {
    await client.send(new DeleteTableCommand({ TableName: TABLE_NAME }));
    console.log(`[OK] Tabela "${TABLE_NAME}" deletada com sucesso`);
  } catch (err: unknown) {
    const errorName = (err as { name?: string }).name;
    if (errorName === 'ResourceNotFoundException') {
      console.log(`[i] Tabela "${TABLE_NAME}" não existe. Nada a fazer.`);
      return;
    }
    throw err;
  }
}

deleteTable().catch((err) => {
  console.error('[X] Erro:', err);
  process.exit(1);
});