import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import type { OpenTaskStatus } from '../events/task.events';

const OPEN_STATUSES: readonly OpenTaskStatus[] = ['PENDING', 'IN_PROGRESS'];

/** Entrada de `PATCH …/assignee`. */
export class AssignTaskDto {
  @ApiProperty({ description: 'Novo responsável (UUID v4 de um usuário)', example: 'c5afce1e-dbd3-4606-a69f-cc930471cef8' })
  @IsUUID('4', { message: 'assigneeId deve ser um UUID v4' })
  assigneeId!: string;
}

/**
 * Entrada de `PATCH …/status`.
 *
 * `DONE` fica de fora DE PROPÓSITO: concluir é uma ação de domínio própria (`POST …/complete`), que registra
 * `completedAt` e é terminal. Aceitar `DONE` aqui criaria dois caminhos para a mesma regra — e um deles
 * pularia o `completedAt`. O tipo `OpenTaskStatus` garante o mesmo no compilador.
 */
export class ChangeTaskStatusDto {
  @ApiProperty({
    description: 'Status de destino. Para concluir a tarefa, use `POST …/complete`.',
    enum: OPEN_STATUSES,
    example: 'IN_PROGRESS',
  })
  @IsIn(OPEN_STATUSES, { message: `status deve ser um de: ${OPEN_STATUSES.join(', ')} (para concluir, use POST .../complete)` })
  status!: OpenTaskStatus;
}
