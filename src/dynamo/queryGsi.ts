import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from './client';
import { gsiKeys } from './model';

async function ap4TasksByAssignee(assigneeId: string): Promise<void> {
  console.log(`\n=== AP4: Tarefas atribuídas ao usuário ${assigneeId} ===`);

  const { GSI1PK } = gsiKeys.taskByAssignee(assigneeId, '', '');
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': GSI1PK,
        ':skPrefix': 'TASK#',
      },
      ScanIndexForward: false, // mais recentes primeiro
    }),
  );

  for (const item of result.Items ?? []) {
    console.log(`  - [${item.createdAt}] ${item.title} (${item.status}) — projeto ${item.projectId}`);
  }
  console.log(`  Total: ${result.Count} tarefas`);
}

async function main(): Promise<void> {
  await ap4TasksByAssignee('u1');
  await ap4TasksByAssignee('u2');
}

main().catch((err) => {
  console.error('[X] Erro:', err);
  process.exit(1);
});