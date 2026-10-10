import {
  CreateTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { TABLE_NAME } from './client';

const client = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

async function createTable(): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    console.log(`[OK] Tabela "${TABLE_NAME}" já existe`);
    return;
  } catch (err: unknown) {
    const errorName = (err as { name?: string }).name;

    if (errorName !== 'ResourceNotFoundException') {
      console.error(`[X] Erro inesperado ao verificar a tabela: ${errorName}`);
      throw err;
    }

    console.log(`[i] Tabela "${TABLE_NAME}" não existe. Criando...`);
  }

  console.log(`[*] Criando tabela "${TABLE_NAME}"...`);

    await client.send(
    new CreateTableCommand({
        TableName: TABLE_NAME,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
        ],
        KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
        {
            IndexName: 'GSI1',
            KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
        },
        ],
    }),
    );

  console.log(`[OK] Tabela "${TABLE_NAME}" criada com sucesso`);
  console.log(`     PK: PK (String)`);
  console.log(`     SK: SK (String)`);
  console.log(`     GSI1PK: GSI1PK (String)`);
  console.log(`     GSI1SK: GSI1SK (String)`);
  console.log(`     Billing: PAY_PER_REQUEST`);
}

createTable().catch((err) => {
  console.error('[X] Erro:', err);
  process.exit(1);
});