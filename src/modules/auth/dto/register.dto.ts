import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Entrada do cadastro.
 *
 * Validado pelo `ValidationPipe` global com `whitelist` + `forbidNonWhitelisted`: qualquer campo
 * fora desta classe (ex.: `isAdmin: true`) é rejeitado com 400 — defesa contra mass assignment
 * (OWASP A03/API6).
 */
export class RegisterDto {
  @ApiProperty({ description: 'E-mail único do usuário', example: 'demo@taskflow.dev', format: 'email' })
  @IsEmail({}, { message: 'Email inválido' })
  email!: string;

  @ApiProperty({ description: 'Nome de exibição', example: 'Demo', minLength: 3, maxLength: 100 })
  @IsString()
  @MinLength(3, { message: 'Nome deve ter ao menos 3 caracteres' })
  @MaxLength(100)
  name!: string;

  /**
   * O teto de 72 NÃO é arbitrário: o bcrypt ignora silenciosamente tudo o que vem depois do 72º byte.
   * Sem esse limite, uma senha de 100 caracteres daria uma falsa sensação de segurança — os últimos
   * 28 nunca entrariam no hash (OWASP A02/A07).
   */
  @ApiProperty({
    description: 'Senha. Entre 8 e 72 caracteres (72 é o limite efetivo do bcrypt).',
    example: 'senha12345',
    minLength: 8,
    maxLength: 72,
    format: 'password',
  })
  @IsString()
  @MinLength(8, { message: 'Senha deve ter ao menos 8 caracteres' })
  @MaxLength(72, { message: 'Senha deve ter no máximo 72 caracteres' })
  password!: string;
}
