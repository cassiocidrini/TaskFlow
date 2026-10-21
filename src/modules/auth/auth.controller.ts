import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthenticatedUserDto, LoginResponseDto, RegisterResponseDto } from './dto/auth.responses';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser, type AuthenticatedUser } from './current-user.decorator';

/**
 * Borda HTTP da autenticação: cadastro, login (emissão de JWT) e identificação do usuário.
 *
 * Diferente dos controllers de domínio, este NÃO tem `@UseGuards` na classe: `register` e `login`
 * precisam ser públicos. A proteção contra força bruta vem do rate limit por rota (`@Throttle`),
 * mais rígido que o global de 100 req/min (OWASP A04/A07).
 *
 * Controllers não têm regra de negócio: validam a entrada (DTOs) e delegam ao {@link AuthService}.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Cadastro. 3 tentativas por minuto por IP: suficiente para humanos, caro para robôs. */
  @Post('register')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Cadastrar usuário',
    description: 'Cria um usuário com a senha armazenada como hash bcrypt. A resposta nunca contém a senha.',
  })
  @ApiResponse({ status: 201, description: 'Usuário criado.', type: RegisterResponseDto })
  @ApiResponse({ status: 400, description: 'Entrada inválida (e-mail, tamanho de nome/senha) ou campo não permitido no body.' })
  @ApiResponse({ status: 409, description: 'E-mail já cadastrado.' })
  @ApiResponse({ status: 429, description: 'Limite de 3 cadastros por minuto excedido.' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.email, dto.name, dto.password);
  }

  /**
   * Login. 5 tentativas por minuto por IP (anti força bruta).
   *
   * `@HttpCode(200)` porque o login não cria um recurso: o NestJS responde 201 em todo `POST` por padrão,
   * e 201 significa "recurso criado". Aqui se emite um token sobre uma sessão que não é persistida.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Autenticar e obter um JWT',
    description:
      'Devolve um `accessToken`. Use-o no botão **Authorize** (acima) ou no header `Authorization: Bearer <token>`.',
  })
  @ApiResponse({ status: 200, description: 'Credenciais válidas; token emitido.', type: LoginResponseDto })
  @ApiResponse({ status: 400, description: 'Entrada inválida (ex.: e-mail malformado).' })
  @ApiResponse({
    status: 401,
    description: 'Credenciais inválidas. A mensagem é a mesma para e-mail inexistente e senha errada (anti-enumeração).',
  })
  @ApiResponse({ status: 429, description: 'Limite de 5 tentativas por minuto excedido.' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  /** Devolve a identidade contida no JWT validado — útil para o cliente conferir "quem sou eu". */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Usuário autenticado', description: 'Dados do usuário extraídos do JWT validado.' })
  @ApiResponse({ status: 200, description: 'Token válido.', type: AuthenticatedUserDto })
  @ApiResponse({ status: 401, description: 'Token ausente, malformado, com assinatura inválida ou expirado.' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
