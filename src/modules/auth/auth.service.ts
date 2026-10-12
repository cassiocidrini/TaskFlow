import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuthService {
  private readonly SALT_ROUNDS = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(email: string, name: string, password: string) {
    // 1. Verifica se já existe
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email já cadastrado');
    }

    // 2. Hash da senha
    const hashedPassword = await bcrypt.hash(password, this.SALT_ROUNDS);

    // 3. Cria o usuário
    const user = await this.prisma.user.create({
      data: { email, name, password: hashedPassword },
    });

    return { userId: user.id, email: user.email, name: user.name };
  }

  async login(email: string, password: string) {
    // 1. Busca o usuário
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    // 2. Compara senha com hash
    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    // 3. Gera o JWT
    const payload = { sub: user.id, email: user.email };
    const accessToken = await this.jwt.signAsync(payload);

    return { accessToken };
  }
}