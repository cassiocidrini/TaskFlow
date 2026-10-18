import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Schema de RESPOSTA de um projeto (documentação OpenAPI).
 *
 * Espelha o `projectSelect` do {@link ProjectsService}: só os campos escolhidos explicitamente saem da API.
 * O `ownerId` fica de fora — é sempre o próprio usuário autenticado, e expor colunas por padrão vazaria
 * qualquer campo sensível adicionado no futuro (OWASP API3 — Excessive Data Exposure).
 */
export class ProjectResponseDto {
  @ApiProperty({ description: 'ID do projeto (UUID v4)', example: 'bab4a090-6a9f-41eb-b3f6-b0302ee4cf87' })
  id!: string;

  @ApiProperty({ description: 'Nome do projeto', example: 'Lançamento do app' })
  name!: string;

  @ApiPropertyOptional({
    description: 'Descrição livre',
    example: 'Tudo o que falta para a versão 1.0',
    nullable: true,
    type: String,
  })
  description!: string | null;

  @ApiProperty({ description: 'Data de criação (ISO 8601)', example: '2026-10-18T04:21:32.675Z' })
  createdAt!: Date;
}
