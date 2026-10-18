import { ApiProperty } from '@nestjs/swagger';

/**
 * Schemas de RESPOSTA do módulo de autenticação, usados apenas pela documentação OpenAPI.
 *
 * Por que classes, e não as interfaces/objetos que o service já devolve? Interfaces TypeScript
 * desaparecem na compilação; o Swagger só consegue desenhar o formato de uma resposta a partir
 * de algo que existe em runtime. Estas classes não têm lógica: são o contrato público da API.
 *
 * Repare no que NÃO existe aqui: `password`. Nenhuma resposta expõe a senha nem o hash
 * (OWASP API3 — Excessive Data Exposure).
 */
export class RegisterResponseDto {
  @ApiProperty({ description: 'ID do usuário criado (UUID v4)', example: 'c5afce1e-dbd3-4606-a69f-cc930471cef8' })
  userId!: string;

  @ApiProperty({ description: 'E-mail cadastrado', example: 'demo@taskflow.dev' })
  email!: string;

  @ApiProperty({ description: 'Nome de exibição', example: 'Demo' })
  name!: string;
}

export class LoginResponseDto {
  @ApiProperty({
    description:
      'JWT assinado com HS256. Envie em `Authorization: Bearer <token>`. Expira conforme `JWT_EXPIRES_IN` (padrão: 1h).',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjNWFmY2UxZSJ9.assinatura',
  })
  accessToken!: string;
}

/** O usuário autenticado, exatamente como o `JwtStrategy.validate()` o anexa ao request. */
export class AuthenticatedUserDto {
  @ApiProperty({ description: 'ID do usuário (claim `sub` do JWT)', example: 'c5afce1e-dbd3-4606-a69f-cc930471cef8' })
  userId!: string;

  @ApiProperty({ description: 'E-mail do usuário (claim `email` do JWT)', example: 'demo@taskflow.dev' })
  email!: string;
}
