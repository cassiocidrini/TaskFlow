import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from './client';
import { keys } from './model';

async function ap1TasksOfProject(projectId: string): Promise<void> {
  console.log(`\n=== AP1: Tarefas do projeto ${projectId} (mais recentes primeiro) ===`);

  const { PK } = keys.task(projectId, '', '');
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': PK,
        ':skPrefix': 'TASK#',
      },
      ScanIndexForward: false,
    }),
  );

  for (const item of result.Items ?? []) {
    console.log(`  - [${item.createdAt}] ${item.title} (${item.status})`);
  }
  console.log(`  Total: ${result.Count} tarefas`);
}

async function ap2ProjectsOfUser(userId: string): Promise<void> {
  console.log(`\n=== AP2: Projetos do usuário ${userId} ===`);

  const { PK } = keys.user(userId);
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': PK,
        ':skPrefix': 'PROJECT#',
      },
    }),
  );

  for (const item of result.Items ?? []) {
    console.log(`  - ${item.name} (${item.projectId})`);
  }
  console.log(`  Total: ${result.Count} projetos`);
}

async function ap3GetTask(
  projectId: string,
  createdAt: string,
  taskId: string,
): Promise<void> {
  console.log(`\n=== AP3: Buscar tarefa ${taskId} do projeto ${projectId} ===`);

  const { PK, SK } = keys.task(projectId, createdAt, taskId);
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK, SK },
    }),
  );

  if (!result.Item) {
    console.log(`  [i] Tarefa não encontrada`);
    return;
  }

  console.log(`  - ${result.Item.title}`);
  console.log(`    Status: ${result.Item.status}`);
  console.log(`    Criada em: ${result.Item.createdAt}`);
}

async function main(): Promise<void> {
  await ap1TasksOfProject('p1');
  await ap2ProjectsOfUser('u1');
  await ap3GetTask('p1', '2026-10-05T14:30:00Z', 't2');
}

main().catch((err) => {
  console.error('[X] Erro:', err);
  process.exit(1);
});