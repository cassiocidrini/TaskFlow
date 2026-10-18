import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

/**
 * Entrada do login.
 *
 * A senha NÃO tem regra de tamanho aqui, de propósito: validar o formato da senha no login daria ao
 * atacante uma pista de quais tentativas são "possíveis". Qualquer senha errada vira o mesmo 401.
 */
export class LoginDto {
  @ApiProperty({ description: 'E-mail cadastrado', example: 'demo@taskflow.dev', format: 'email' })
  @IsEmail({}, { message: 'Email inválido' })
  email!: string;

  @ApiProperty({ description: 'Senha do usuário', example: 'senha12345', format: 'password' })
  @IsString()
  password!: string;
}
