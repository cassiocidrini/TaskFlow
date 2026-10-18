import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';

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
  /**
   * Custo 10 = 2^10 iterações. Lento o bastante para encarecer ataques offline a hashes vazados,
   * rápido o bastante para não degradar o login. Aumentar 1 ponto dobra o tempo de cada hash.
   */
  private readonly SALT_ROUNDS = 10;

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

    const hashedPassword = await bcrypt.hash(password, this.SALT_ROUNDS);

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
   * **Limitação conhecida — timing attack:** quando o e-mail não existe, o `bcrypt.compare` não roda e a
   * resposta volta em ~1 ms, contra ~60–100 ms quando existe. A mensagem é igual, mas o TEMPO revela o
   * cadastro. Correção: comparar contra um hash fictício também no caminho "usuário não encontrado".
   *
   * @throws UnauthorizedException (401) com a mensagem genérica `Credenciais inválidas`.
   */
  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    // Claims mínimas: nada sensível no payload — o JWT é só Base64, qualquer um consegue ler
    const payload = { sub: user.id, email: user.email };
    const accessToken = await this.jwt.signAsync(payload);

    return { accessToken };
  }
}
