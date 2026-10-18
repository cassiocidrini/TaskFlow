/**
 * LABORATÓRIO de modelagem DynamoDB (Módulo 04) — não faz parte da API, que persiste em PostgreSQL.
 * Os scripts de `src/dynamo/` modelam o MESMO domínio em Single-Table Design para comparar as abordagens.
 *
 * Cliente compartilhado pelos scripts de consulta. O `DynamoDBDocumentClient` aceita objetos JavaScript comuns
 * (`{ PK: 'USER#u1' }`); o cliente de baixo nível exigiria o formato tipado (`{ PK: { S: 'USER#u1' } }`).
 *
 * Aponta para o LocalStack (`localhost:4566`), com credenciais fictícias que ele aceita. Na AWS real, omite-se
 * o `endpoint` e as credenciais vêm do ambiente/IAM — nunca fixas no código.
 *
 * Limitação: endpoint e credenciais estão fixos e REPETIDOS em `createTable`, `deleteTable` e `listTables`.
 * O certo seria este único cliente, configurado por variável de ambiente.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const baseClient = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

export const dynamo = DynamoDBDocumentClient.from(baseClient);

export const TABLE_NAME = 'TaskFlowTable';