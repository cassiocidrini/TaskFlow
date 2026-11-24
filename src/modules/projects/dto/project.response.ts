import { ApiProperty } from '@nestjs/swagger';

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

  // Obrigatório (e `nullable`): o `select` sempre devolve o campo. Documentado como opcional, uma remoção futura dele
  // passaria pelo oasdiff como inofensiva (Módulo 14.4c, ADR-0008)
  @ApiProperty({
    description: 'Descrição livre (`null` quando não informada)',
    example: 'Tudo o que falta para a versão 1.0',
    nullable: true,
    type: String,
  })
  description!: string | null;

  @ApiProperty({ description: 'Data de criação (ISO 8601)', example: '2026-10-18T04:21:32.675Z' })
  createdAt!: Date;
}
