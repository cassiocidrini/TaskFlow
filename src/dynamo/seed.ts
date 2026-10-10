import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLE_NAME } from './client';
import { keys, gsiKeys } from './model';

interface User {
  userId: string;
  name: string;
  email: string;
}

interface Project {
  projectId: string;
  ownerId: string;
  name: string;
}

interface Task {
  taskId: string;
  projectId: string;
  title: string;
  status: string;
  createdAt: string;
  assigneeId: string;
}

const users: User[] = [
  { userId: 'u1', name: 'Cassio', email: 'cassio@test.com' },
  { userId: 'u2', name: 'Maria', email: 'maria@test.com' },
];

const projects: Project[] = [
  { projectId: 'p1', ownerId: 'u1', name: 'Refatorar API' },
  { projectId: 'p2', ownerId: 'u1', name: 'Estudar DynamoDB' },
  { projectId: 'p3', ownerId: 'u2', name: 'Migrar banco' },
];

const tasks: Task[] = [
  { taskId: 't1', projectId: 'p1', title: 'Criar endpoint de listagem', status: 'DONE', createdAt: '2026-10-01T10:00:00Z', assigneeId: 'u1' },
  { taskId: 't2', projectId: 'p1', title: 'Adicionar testes', status: 'IN_PROGRESS', createdAt: '2026-10-05T14:30:00Z', assigneeId: 'u1' },
  { taskId: 't3', projectId: 'p1', title: 'Documentar API', status: 'PENDING', createdAt: '2026-10-08T09:15:00Z', assigneeId: 'u2' },
  { taskId: 't4', projectId: 'p2', title: 'Ler documentação oficial', status: 'DONE', createdAt: '2026-10-03T08:00:00Z', assigneeId: 'u1' },
  { taskId: 't5', projectId: 'p2', title: 'Modelar tabela', status: 'IN_PROGRESS', createdAt: '2026-10-07T16:45:00Z', assigneeId: 'u2' },
  { taskId: 't6', projectId: 'p3', title: 'Planejar migração', status: 'PENDING', createdAt: '2026-10-06T11:20:00Z', assigneeId: 'u2' },
];

async function seed(): Promise<void> {
  console.log(`[*] Populando "${TABLE_NAME}"...\n`);

  for (const user of users) {
    const { PK, SK } = keys.user(user.userId);
    await dynamo.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK,
          SK,
          entityType: 'User',
          ...user,
        },
      }),
    );
    console.log(`[+] User: ${user.name} (${user.userId})`);
  }

  for (const project of projects) {
    const { PK, SK } = keys.project(project.ownerId, project.projectId);
    await dynamo.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK,
          SK,
          entityType: 'Project',
          ...project,
        },
      }),
    );
    console.log(`[+] Project: ${project.name} (${project.projectId})`);
  }

    for (const task of tasks) {
    const { PK, SK } = keys.task(task.projectId, task.createdAt, task.taskId);
    const { GSI1PK, GSI1SK } = gsiKeys.taskByAssignee(task.assigneeId, task.createdAt, task.taskId);

    await dynamo.send(
        new PutCommand({
        TableName: TABLE_NAME,
        Item: {
            PK,
            SK,
            GSI1PK,
            GSI1SK,
            entityType: 'Task',
            ...task,
        },
        }),
    );
    console.log(`[+] Task: ${task.title} (${task.taskId}) → ${task.assigneeId}`);
    }

  console.log(`\n[OK] Seed concluído: ${users.length} users, ${projects.length} projects, ${tasks.length} tasks`);
}

seed().catch((err) => {
  console.error('[X] Erro:', err);
  process.exit(1);
});