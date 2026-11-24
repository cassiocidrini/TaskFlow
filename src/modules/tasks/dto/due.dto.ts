import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsString,
  Matches,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

/**
 * Fuso IANA válido (`America/Sao_Paulo`, `Europe/Lisbon`, `UTC`), conferido pelo próprio `Intl` do Node: a lista é a
 * do ICU embutido, atualizada com o runtime, e não uma lista copiada para o código.
 *
 * Offsets (`+03:00`, `-0300`) são RECUSADOS mesmo sendo aceitos pelo `Intl`: o objetivo do campo é guardar o NOME do
 * fuso, porque o offset muda no horário de verão e o nome não.
 */
export function isIanaTimeZone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 64 || /^[+-]/.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function IsIanaTimeZone(options?: ValidationOptions) {
  return function (target: object, propertyName: string): void {
    registerDecorator({
      name: 'isIanaTimeZone',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} deve ser um fuso IANA, como America/Sao_Paulo (não um offset como -03:00)`,
        ...options,
      },
      validator: { validate: isIanaTimeZone },
    });
  };
}

/**
 * Prazo no formato novo (Módulo 14.4): o instante E o fuso em que o usuário pensa. Usado na entrada e na saída.
 */
export class DueDto {
  /**
   * ISO 8601 COM fuso explícito (`Z` ou `±hh:mm`). Sem ele, "2026-12-31T23:59:59" é ambíguo: em que fuso foi escrito?
   * A API guarda e devolve o instante em UTC; com o `timezone`, o cliente reconstrói a hora local.
   */
  @ApiProperty({
    description: 'Instante do prazo, ISO 8601 com fuso explícito (`Z` ou `±hh:mm`). Devolvido em UTC.',
    example: '2026-12-31T23:59:59-03:00',
    format: 'date-time',
  })
  @IsDateString({ strict: true })
  @Matches(/(Z|[+-]\d{2}:\d{2})$/, {
    message: 'due.at deve ter fuso explícito (terminar em Z ou ±hh:mm)',
  })
  at!: string;

  @ApiProperty({
    description:
      'Fuso IANA do usuário, para lembretes no dia certo ("vence hoje"). Nome, não offset: o offset muda no horário de verão.',
    example: 'America/Sao_Paulo',
    maxLength: 64,
  })
  @IsString()
  @IsIanaTimeZone()
  timezone!: string;
}

/** Prazo na SAÍDA: o fuso pode ser `null` (desconhecido), porque o formato antigo não o registrava. */
export class DueResponseDto {
  @ApiProperty({ format: 'date-time', example: '2027-01-01T02:59:59.000Z', description: 'Instante, em UTC' })
  at!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'America/Sao_Paulo',
    description:
      'Fuso IANA; `null` quando o prazo veio do formato antigo (`dueDate`, removido na 14.4b), que não o informava',
  })
  timezone!: string | null;
}
