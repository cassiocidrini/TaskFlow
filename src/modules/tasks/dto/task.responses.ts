import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Schemas de RESPOSTA do módulo de tarefas (documentação OpenAPI).
 *
 * Os handlers devolvem interfaces (`TaskSnapshot`, `CursorPage<TaskRead>`, `TaskHistory`), que desaparecem
 * na compilação. Estas classes existem em runtime só para o Swagger desenhar o contrato — não têm lógica e
 * não substituem os tipos internos.
 *
 * Duas FONTES de dados aparecem aqui, e a diferença é o coração do CQRS + Event Sourcing:
 * - {@link TaskSnapshotDto} e {@link TaskHistoryDto}: vêm do **agregado reconstruído dos eventos** —
 *   sempre consistentes com a escrita;
 * - {@link TaskReadDto}: vem do **Read Model** (`tasks_read`), atualizado por projeções DEPOIS da resposta
 *   do comando — **eventualmente consistente** (pode levar alguns milissegundos para refletir a mudança).
 */

const TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE'] as const;
const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
const TASK_EVENT_TYPES = ['TaskCreated', 'TaskAssigned', 'TaskStatusChanged', 'TaskCompleted'] as const;

const UUID_EXAMPLE = '370b268e-18ba-444c-ae17-2716b0269232';
const USER_EXAMPLE = 'c5afce1e-dbd3-4606-a69f-cc930471cef8';

export class CreateTaskResponseDto {
  @ApiProperty({ description: 'ID da tarefa criada (UUID v4) — também é o ID do agregado no Event Store', example: UUID_EXAMPLE })
  taskId!: string;
}

/** Estado da tarefa logo após um comando de ciclo de vida, lido do agregado (não do Read Model). */
export class TaskSnapshotDto {
  @ApiProperty({ example: UUID_EXAMPLE })
  taskId!: string;

  @ApiProperty({ enum: TASK_STATUSES, example: 'IN_PROGRESS', description: '`DONE` é terminal: depois dele, novos comandos respondem 409' })
  status!: (typeof TASK_STATUSES)[number];

  @ApiPropertyOptional({ description: 'Responsável atual', example: USER_EXAMPLE })
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'Preenchido quando a tarefa é concluída (ISO 8601)', example: '2026-10-18T05:43:16.305Z' })
  completedAt?: string;
}

/** Uma linha do Read Model `tasks_read` — projeção desnormalizada, otimizada para listagem. */
export class TaskReadDto {
  @ApiProperty({ example: UUID_EXAMPLE })
  id!: string;

  @ApiProperty({ example: 'bab4a090-6a9f-41eb-b3f6-b0302ee4cf87' })
  projectId!: string;

  @ApiProperty({ example: 'Corrigir bug urgente no login' })
  title!: string;

  @ApiProperty({ enum: TASK_STATUSES, example: 'PENDING' })
  status!: (typeof TASK_STATUSES)[number];

  @ApiProperty({
    enum: TASK_PRIORITIES,
    example: 'HIGH',
    description: 'Calculada pelo servidor na criação (Strategy Pattern): palavras como "urgente" e "bug" no título resultam em HIGH',
  })
  priority!: (typeof TASK_PRIORITIES)[number];

  @ApiPropertyOptional({ nullable: true, type: String, example: USER_EXAMPLE })
  assigneeId!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time', example: '2026-12-31T23:59:59.000Z' })
  dueDate!: Date | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time', example: null })
  completedAt!: Date | null;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T04:28:59.208Z' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T04:28:59.208Z' })
  updatedAt!: Date;
}

/** Página de tarefas (paginação por cursor). */
export class TaskPageDto {
  @ApiProperty({ type: [TaskReadDto], description: 'Mais recentes primeiro (`createdAt` desc, `id` como desempate)' })
  items!: TaskReadDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: UUID_EXAMPLE,
    description: 'Envie como `?cursor=` para a próxima página. `null` = não há mais páginas.',
  })
  nextCursor!: string | null;
}

/** Estado atual da tarefa RECONSTRUÍDO a partir dos eventos (replay), não lido do Read Model. */
export class TaskCurrentStateDto {
  @ApiProperty({ example: 'Corrigir bug crítico' })
  title!: string;

  @ApiProperty({ enum: TASK_STATUSES, example: 'DONE' })
  status!: (typeof TASK_STATUSES)[number];

  @ApiProperty({ enum: TASK_PRIORITIES, example: 'HIGH' })
  priority!: (typeof TASK_PRIORITIES)[number];

  @ApiPropertyOptional({ example: USER_EXAMPLE })
  assigneeId?: string;

  @ApiPropertyOptional({ format: 'date-time', example: '2026-12-31T23:59:59.000Z' })
  dueDate?: string;

  @ApiPropertyOptional({ format: 'date-time', example: '2026-10-18T05:43:16.305Z' })
  completedAt?: string;

  @ApiProperty({ description: 'Quantos eventos a tarefa tem — base da concorrência otimista', example: 4 })
  version!: number;
}

/** Um evento da linha do tempo, exatamente como gravado no Event Store (append-only). */
export class TaskHistoryEntryDto {
  @ApiProperty({ description: 'Posição do evento no histórico da tarefa (1, 2, 3…)', example: 3 })
  version!: number;

  @ApiProperty({ enum: TASK_EVENT_TYPES, example: 'TaskStatusChanged' })
  type!: (typeof TASK_EVENT_TYPES)[number];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Payload do evento; o formato depende do `type`',
    example: { taskId: UUID_EXAMPLE, from: 'PENDING', to: 'IN_PROGRESS' },
  })
  data!: Record<string, unknown>;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T05:43:16.294Z' })
  occurredAt!: Date;
}

/** Histórico completo: a auditoria que um CRUD não consegue oferecer. */
export class TaskHistoryDto {
  @ApiProperty({ example: UUID_EXAMPLE })
  taskId!: string;

  @ApiProperty({ type: TaskCurrentStateDto })
  current!: TaskCurrentStateDto;

  @ApiProperty({ type: [TaskHistoryEntryDto], description: 'Do evento mais antigo ao mais recente' })
  history!: TaskHistoryEntryDto[];
}
