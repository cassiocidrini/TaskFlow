import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { DueDto } from './due.dto';

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
 *
 * **Prazo: só `due { at, timezone }`** desde o contract do Módulo 14.4b. O `dueDate` antigo foi depreciado na 14.4a
 * e removido depois que a versão mínima do app excluiu as versões que o mandavam; quem ainda o enviar recebe 400 pelo
 * `forbidNonWhitelisted` (política no ADR-0008).
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

  @ApiPropertyOptional({
    type: DueDto,
    description: 'Prazo: o instante e o fuso IANA do usuário (para lembretes no dia certo).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => DueDto)
  due?: DueDto;
}
