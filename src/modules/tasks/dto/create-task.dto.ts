import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { DueDto, NotTogetherWith } from './due.dto';

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
 * **Prazo em dois formatos durante o expand/contract (Módulo 14.4):** `due { at, timezone }` é o atual; `dueDate` é o
 * antigo, aceito enquanto houver app instalado que o manda (sai no contract, depois que a versão mínima excluir esses
 * apps). Os dois juntos = 400. Quem usa o antigo recebe os headers `Deprecation`/`Sunset` e entra na métrica de uso.
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
   * Formato ANTIGO do prazo (só o instante, sem o fuso). Depreciado: continua aceito, e vira `due` com
   * `timezone: null` na borda (o fuso é desconhecido, e não é inventado).
   */
  @ApiPropertyOptional({
    description:
      '**Depreciado:** use `due`. Prazo como instante ISO 8601, sem o fuso do usuário. Não pode vir junto com `due`.',
    example: '2026-12-31T23:59:59Z',
    format: 'date-time',
    deprecated: true,
  })
  @IsOptional()
  @IsDateString()
  @NotTogetherWith('due')
  dueDate?: string;

  @ApiPropertyOptional({
    type: DueDto,
    description: 'Prazo: o instante e o fuso IANA do usuário (para lembretes no dia certo). Substitui `dueDate`.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => DueDto)
  due?: DueDto;
}
