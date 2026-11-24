import { ApiProperty } from '@nestjs/swagger';

/** As flags avaliadas para quem pergunta (Módulo 14.6): só o RESULTADO, nunca a regra. */
export class FeatureFlagsResponseDto {
  @ApiProperty({
    description:
      'Cada flag existente, ligada (`true`) ou desligada (`false`) para este usuário e este app. Flag que não ' +
      'aparece aqui não existe: trate como desligada.',
    type: 'object',
    additionalProperties: { type: 'boolean' },
    example: { 'task-list-with-stats': true },
  })
  flags!: Record<string, boolean>;
}
