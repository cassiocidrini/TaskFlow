import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * Entrada da criação de tarefa.
 *
 * O que o cliente NÃO controla, de propósito:
 * - **`priority`:** calculada no servidor por uma Strategy (`KeywordPriorityStrategy`), para a regra de
 *   negócio não depender de cada cliente implementá-la igual;
 * - **`status`:** toda tarefa nasce `PENDING`; mudar status é um comando próprio;
 * - **`projectId` e o dono:** vêm da URL validada e do JWT, nunca do body (OWASP A01).
 *
 * Qualquer campo extra é rejeitado com 400 (`forbidNonWhitelisted`) — anti mass assignment.
 */
export class CreateTaskDto {
  @ApiProperty({
    description: 'Título. Palavras como "urgente" e "bug" elevam a prioridade calculada para HIGH.',
    example: 'Corrigir bug urgente no login',
    minLength: 3,
    maxLength: 200,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: 'Responsável inicial (UUID v4 de um usuário)', example: 'c5afce1e-dbd3-4606-a69f-cc930471cef8' })
  @IsOptional()
  @IsUUID('4')
  assigneeId?: string;

  /**
   * String ISO 8601 (e não `Date`) porque é assim que trafega no JSON. O controller converte para `Date`
   * na borda, e o evento volta a guardá-la como ISO: eventos são mensagens serializadas.
   */
  @ApiPropertyOptional({ description: 'Prazo (ISO 8601)', example: '2026-12-31T23:59:59Z', format: 'date-time' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
