import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Custo do bcrypt: 10 = 2^10 iterações. Lento o bastante para encarecer ataques offline a hashes vazados,
 * rápido o bastante para não degradar o login. Aumentar 1 ponto dobra o tempo de cada hash.
 */
export const BCRYPT_SALT_ROUNDS = 10;

/**
 * Hash bcrypt de um segredo aleatório que ninguém conhece, usado no login quando o e-mail não existe.
 *
 * **Por que existe (timing attack, OWASP A07):** sem ele, "usuário não encontrado" respondia em ~1 ms e
 * "senha errada" em ~60–100 ms. A mensagem era a mesma, mas o TEMPO revelava quais e-mails estão cadastrados.
 * Comparar contra este hash faz os dois caminhos custarem o mesmo.
 *
 * Precisa ter o MESMO custo de {@link BCRYPT_SALT_ROUNDS} (o `$10$` do prefixo), senão o tempo volta a
 * vazar. Um teste unitário trava esse acoplamento. Pré-calculado para não pagar um hash no boot.
 */
export const DUMMY_PASSWORD_HASH = '$2b$10$NIcoG2SaEIFkqcPuBZHSFuI2EF7e29gkpuqsrOyQWLi91swRIg1k.';

/**
 * Regras de autenticação: cadastro com senha protegida por hash e emissão de JWT.
 *
 * Estilo Layered (service → Prisma) de propósito: autenticação é CRUD simples, sem histórico relevante,
 * então não recebe a cerimônia de Event Sourcing do módulo de tarefas.
 *
 * **Performance:** `bcrypt.hash`/`compare` são as versões ASSÍNCRONAS, que rodam no thread pool do libuv
 * (4 threads por padrão) e não bloqueiam o Event Loop. As versões `*Sync` travariam TODAS as requisições
 * durante cada hash (~60–100 ms). Sob carga, cadastro e login disputam essas 4 threads — ver Módulo 11.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Cria o usuário com a senha como hash bcrypt (salt embutido; a mesma senha gera hashes diferentes).
   *
   * @returns os dados públicos do usuário — nunca a senha nem o hash (OWASP API3).
   * @throws ConflictException (409) se o e-mail já existir. A unicidade também é garantida pelo índice
   *   `UNIQUE` do banco; a checagem prévia existe para devolver uma mensagem clara.
   */
  async register(email: string, name: string, password: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email já cadastrado');
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    const user = await this.prisma.user.create({
      data: { email, name, password: hashedPassword },
    });

    return { userId: user.id, email: user.email, name: user.name };
  }

  /**
   * Valida as credenciais e emite um JWT (`sub` = userId).
   *
   * **Anti-enumeração (OWASP A07):** "e-mail inexistente" e "senha errada" respondem a MESMA mensagem,
   * para a API não confirmar quais e-mails estão cadastrados.
   *
   * **Anti timing attack:** o `bcrypt.compare` roda SEMPRE, contra {@link DUMMY_PASSWORD_HASH} quando o
   * e-mail não existe. Assim o tempo de resposta não denuncia o cadastro. A decisão fica numa condição
   * só (`!user || !passwordMatches`): mesmo que a senha "batesse" com o hash fictício, o login falha.
   *
   * @throws UnauthorizedException (401) com a mensagem genérica `Credenciais inválidas`.
   */
  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });

    const passwordMatches = await bcrypt.compare(password, user?.password ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    // Claims mínimas: nada sensível no payload — o JWT é só Base64, qualquer um consegue ler
    const payload = { sub: user.id, email: user.email };
    const accessToken = await this.jwt.signAsync(payload);

    return { accessToken };
  }
}
