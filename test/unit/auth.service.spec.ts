/**
 * `AuthService` — cadastro e login.
 *
 * Protege propriedades de SEGURANÇA, não só o caminho feliz: a senha nunca é salva em texto plano, e-mail
 * duplicado não cria usuário, nenhum token é emitido com senha errada e a MESMA mensagem para "usuário não
 * existe" e "senha errada" (anti-enumeração, OWASP A07).
 *
 * `jest.mock('bcrypt')`: o bcrypt é lento POR DESIGN (~60–100 ms); mockado, a suíte roda em milissegundos.
 * O hashing real é exercitado nos testes E2E.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../../src/modules/auth/auth.service';
import { PrismaService } from '../../src/prisma/prisma.service';

// Mock do bcrypt — evita hashing real (que é lento)
jest.mock('bcrypt');

describe('AuthService', () => {
  let authService: AuthService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
    };
  };
  let jwt: { signAsync: jest.Mock };

  beforeEach(async () => {
    // Arrange: cria mocks das dependências
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

    jwt = {
      signAsync: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================
  // register
  // ============================================================
  describe('register', () => {
    const validEmail = 'teste@test.com';
    const validName = 'Cassio';
    const validPassword = 'senha12345';
    const hashedPassword = '$2b$10$fakehash';

    it('deve criar um usuário com senha hasheada', async () => {
      // Arrange
      prisma.user.findUnique.mockResolvedValue(null);       // email não existe
      (bcrypt.hash as jest.Mock).mockResolvedValue(hashedPassword);
      prisma.user.create.mockResolvedValue({
        id: 'u1',
        email: validEmail,
        name: validName,
        password: hashedPassword,
      });

      // Act
      const result = await authService.register(validEmail, validName, validPassword);

      // Assert
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: validEmail } });
      expect(bcrypt.hash).toHaveBeenCalledWith(validPassword, 10);
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { email: validEmail, name: validName, password: hashedPassword },
      });
      expect(result).toEqual({ userId: 'u1', email: validEmail, name: validName });
      expect(result).not.toHaveProperty('password');        // nunca retornar senha
    });

    it('deve lançar ConflictException se o email já existir', async () => {
      // Arrange
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: validEmail });

      // Act + Assert
      await expect(
        authService.register(validEmail, validName, validPassword),
      ).rejects.toThrow(ConflictException);

      expect(prisma.user.create).not.toHaveBeenCalled();    // não cria duplicado
    });

    it('deve hashear a senha antes de salvar (nunca salvar em texto plano)', async () => {
      // Arrange
      prisma.user.findUnique.mockResolvedValue(null);
      (bcrypt.hash as jest.Mock).mockResolvedValue(hashedPassword);
      prisma.user.create.mockResolvedValue({ id: 'u1', email: validEmail, name: validName });

      // Act
      await authService.register(validEmail, validName, validPassword);

      // Assert
      const createCall = prisma.user.create.mock.calls[0][0];
      expect(createCall.data.password).toBe(hashedPassword);
      expect(createCall.data.password).not.toBe(validPassword);   // a senha original NUNCA é salva
    });
  });

  // ============================================================
  // login
  // ============================================================
  describe('login', () => {
    const validEmail = 'teste@test.com';
    const validPassword = 'senha12345';
    const hashedPassword = '$2b$10$fakehash';
    const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.fake.payload';

    it('deve retornar um accessToken quando as credenciais estiverem corretas', async () => {
      // Arrange
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: validEmail,
        password: hashedPassword,
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      jwt.signAsync.mockResolvedValue(fakeToken);

      // Act
      const result = await authService.login(validEmail, validPassword);

      // Assert
      expect(result).toEqual({ accessToken: fakeToken });
      expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'u1', email: validEmail });
    });

    it('deve lançar UnauthorizedException se o usuário não existir', async () => {
      // Arrange
      prisma.user.findUnique.mockResolvedValue(null);

      // Act + Assert
      await expect(
        authService.login(validEmail, validPassword),
      ).rejects.toThrow(UnauthorizedException);

      expect(bcrypt.compare).not.toHaveBeenCalled();   // não perde tempo comparando
    });

    it('deve lançar UnauthorizedException se a senha estiver errada', async () => {
      // Arrange
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: validEmail,
        password: hashedPassword,
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      // Act + Assert
      await expect(
        authService.login(validEmail, 'senha-errada'),
      ).rejects.toThrow(UnauthorizedException);

      expect(jwt.signAsync).not.toHaveBeenCalled();    // não gera token se a senha errou
    });

    it('deve retornar a mesma mensagem para usuário inexistente e senha errada (anti user enumeration)', async () => {
      // Arrange — cenário 1: usuário não existe
      prisma.user.findUnique.mockResolvedValueOnce(null);
      const erro1 = await authService.login(validEmail, validPassword).catch((e) => e.message);

      // Arrange — cenário 2: senha errada
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u1',
        email: validEmail,
        password: hashedPassword,
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      const erro2 = await authService.login(validEmail, 'outra-senha').catch((e) => e.message);

      // Assert — as duas mensagens devem ser IGUAIS
      expect(erro1).toBe(erro2);
    });
  });
});