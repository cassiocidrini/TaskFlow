import { ApiProperty } from '@nestjs/swagger';

/**
 * Schemas de RESPOSTA de `GET /me/notifications` (documentação OpenAPI). O serviço devolve o `CursorPage` com as
 * linhas do Prisma; estas classes existem só para o Swagger desenhar o contrato.
 */
export class NotificationDto {
  @ApiProperty({
    format: 'uuid',
    example: '6f1d4c9e-2b7a-4e0f-9c3d-1a2b3c4d5e6f',
  })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Destinatário: sempre o usuário do token',
    example: 'c5afce1e-dbd3-4606-a69f-cc930471cef8',
  })
  userId!: string;

  @ApiProperty({
    enum: ['TASK_ASSIGNED', 'TASK_COMPLETED'],
    example: 'TASK_ASSIGNED',
  })
  type!: string;

  @ApiProperty({
    example: 'Você foi atribuído à tarefa "Conciliar pagamentos"',
  })
  message!: string;

  @ApiProperty({
    format: 'uuid',
    example: '370b268e-18ba-444c-ae17-2716b0269232',
  })
  taskId!: string;

  @ApiProperty({
    format: 'uuid',
    example: 'bab4a090-6a9f-41eb-b3f6-b0302ee4cf87',
  })
  projectId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Evento de origem no Kafka (`event-id`): rastreia de onde veio a notificação',
    example: '24dd5249-4eda-4246-a1fc-65bad9635c83',
  })
  eventId!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-10T10:42:47.567Z' })
  createdAt!: string;
}

export class NotificationPageDto {
  @ApiProperty({
    type: [NotificationDto],
    description:
      'Mais recentes primeiro (`createdAt` desc, `id` como desempate)',
  })
  items!: NotificationDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: '6f1d4c9e-2b7a-4e0f-9c3d-1a2b3c4d5e6f',
    description:
      'Envie como `?cursor=` para a próxima página. `null` = não há mais páginas.',
  })
  nextCursor!: string | null;
}
