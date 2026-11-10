import { ApiProperty } from '@nestjs/swagger';

/** Tarefas por status. */
export class TasksByStatusDto {
  @ApiProperty({ example: 4 })
  pending!: number;

  @ApiProperty({ example: 2 })
  inProgress!: number;

  @ApiProperty({ example: 9 })
  done!: number;
}

/**
 * Resposta de `GET /projects/:projectId/stats` (documentação OpenAPI e o tipo devolvido pelo `ReportsService`).
 * Calculada pelo consumer `reports` a partir dos eventos publicados no Kafka: eventualmente consistente.
 */
export class ProjectStatsDto {
  @ApiProperty({
    format: 'uuid',
    example: 'bab4a090-6a9f-41eb-b3f6-b0302ee4cf87',
  })
  projectId!: string;

  @ApiProperty({ description: 'Tarefas do projeto', example: 15 })
  total!: number;

  @ApiProperty({ type: TasksByStatusDto })
  byStatus!: TasksByStatusDto;

  @ApiProperty({
    description: 'Tarefas abertas (não concluídas) sem responsável',
    example: 1,
  })
  unassignedOpen!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Lead time médio (criação → conclusão) das tarefas concluídas, em segundos. `null` sem nenhuma concluída',
    example: 86_400,
  })
  avgLeadTimeSeconds!: number | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Instante do evento mais recente refletido nestes números ("dados até"). `null` = nenhum evento do projeto processado ainda',
    example: '2026-11-10T18:30:02.377Z',
  })
  asOf!: string | null;
}
