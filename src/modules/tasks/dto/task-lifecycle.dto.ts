import { IsIn, IsUUID } from 'class-validator';
import type { OpenTaskStatus } from '../events/task.events';

const OPEN_STATUSES: readonly OpenTaskStatus[] = ['PENDING', 'IN_PROGRESS'];

export class AssignTaskDto {
  @IsUUID('4', { message: 'assigneeId deve ser um UUID v4' })
  assigneeId!: string;
}

export class ChangeTaskStatusDto {
  // DONE fica de fora DE PROPÓSITO: concluir é uma ação de domínio própria (POST .../complete),
  // que registra completedAt e é terminal. Um só caminho para cada regra.
  @IsIn(OPEN_STATUSES, { message: `status deve ser um de: ${OPEN_STATUSES.join(', ')} (para concluir, use POST .../complete)` })
  status!: OpenTaskStatus;
}
