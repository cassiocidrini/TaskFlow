import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Entrada da criação de projeto.
 *
 * Repare no que NÃO está aqui: `ownerId`. O dono é SEMPRE o usuário do JWT, atribuído no servidor.
 * Se o cliente pudesse informá-lo, criaria projetos em nome de outra pessoa (OWASP A01). Um `ownerId`
 * enviado no body é rejeitado com 400 pelo `forbidNonWhitelisted`.
 */
export class CreateProjectDto {
  @ApiProperty({ description: 'Nome do projeto', example: 'Lançamento do app', minLength: 3, maxLength: 100 })
  @IsString()
  @MinLength(3, { message: 'Nome deve ter ao menos 3 caracteres' })
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: 'Descrição livre', example: 'Tudo o que falta para a versão 1.0', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
