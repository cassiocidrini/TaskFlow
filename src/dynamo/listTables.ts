import { ListTablesCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

async function listTables(): Promise<void> {
  const result = await client.send(new ListTablesCommand({}));

  if (!result.TableNames || result.TableNames.length === 0) {
    console.log('Nenhuma tabela encontrada.');
    return;
  }

  console.log(`[OK] ${result.TableNames.length} tabela(s) encontrada(s):`);
  for (const name of result.TableNames) {
    console.log(`     - ${name}`);
  }
}

listTables().catch((err) => {
  console.error('[X] Erro:', err);
  process.exit(1);
});