/**
 * Schema de ambiente (`zod`) — congela as regras de segurança da configuração.
 *
 * Protege: o fail-fast (configuração inválida impede o boot, listando TODOS os erros de uma vez), o segredo
 * JWT com ≥ 32 caracteres, a URL obrigatoriamente PostgreSQL e as conversões de tipo (env vars sempre chegam
 * como string). Se alguém afrouxar uma regra, o PR fica vermelho — mudar o comportamento exige mudar o teste,
 * conscientemente (OWASP A05).
 */
import { validateEnv } from '../../src/config/env.schema';

describe('validateEnv', () => {
  // Arrange compartilhado: o MÍNIMO necessário para a app subir
  const minimalEnv = {
    DATABASE_URL: 'postgresql://taskflow:taskflow123@localhost:5432/taskflow_db?schema=public',
    JWT_SECRET: 'a'.repeat(32),
  };

  // ============================================================
  // Caminho feliz e defaults
  // ============================================================
  describe('com o ambiente mínimo válido', () => {
    it('deve aplicar os defaults seguros de desenvolvimento', () => {
      const env = validateEnv(minimalEnv);

      expect(env).toMatchObject({
        NODE_ENV: 'development',
        PORT: 3000,
        JWT_EXPIRES_IN: '1h',
        CORS_ORIGINS: ['http://localhost:5173'],
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        DISABLE_THROTTLE: false,
      });
    });

    it('deve converter PORT de string para number (env vars sempre chegam como string)', () => {
      const env = validateEnv({ ...minimalEnv, PORT: '8080' });

      expect(env.PORT).toBe(8080);
    });

    it('deve transformar CORS_ORIGINS em array, removendo espaços e itens vazios', () => {
      const env = validateEnv({
        ...minimalEnv,
        CORS_ORIGINS: 'http://localhost:5173 , https://taskflow.app,',
      });

      expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://taskflow.app']);
    });

    it('deve converter DISABLE_THROTTLE="true" para boolean', () => {
      const env = validateEnv({ ...minimalEnv, DISABLE_THROTTLE: 'true' });

      expect(env.DISABLE_THROTTLE).toBe(true);
    });
  });

  // ============================================================
  // Fail-fast: configuração inválida NÃO deixa a app subir
  // ============================================================
  describe('fail-fast', () => {
    it('deve listar TODAS as variáveis obrigatórias ausentes de uma só vez', () => {
      expect(() => validateEnv({})).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET/);
    });

    it('deve rejeitar JWT_SECRET com menos de 32 caracteres', () => {
      expect(() => validateEnv({ ...minimalEnv, JWT_SECRET: 'curto' })).toThrow(
        'JWT_SECRET deve ter pelo menos 32 caracteres',
      );
    });

    it('deve rejeitar DATABASE_URL que não seja PostgreSQL', () => {
      expect(() =>
        validateEnv({ ...minimalEnv, DATABASE_URL: 'mysql://user:pass@localhost:3306/db' }),
      ).toThrow(/DATABASE_URL/);
    });

    it.each(['1hora', 'h1', '10', ''])('deve rejeitar JWT_EXPIRES_IN inválido: "%s"', (value) => {
      expect(() => validateEnv({ ...minimalEnv, JWT_EXPIRES_IN: value })).toThrow(/JWT_EXPIRES_IN/);
    });

    it.each(['0', '70000', 'abc'])('deve rejeitar PORT fora do intervalo ou não numérica: "%s"', (value) => {
      expect(() => validateEnv({ ...minimalEnv, PORT: value })).toThrow(/PORT/);
    });

    it('deve rejeitar uma origem de CORS que não seja URL', () => {
      expect(() => validateEnv({ ...minimalEnv, CORS_ORIGINS: 'http://ok.com,nao-e-url' })).toThrow(
        /CORS_ORIGINS/,
      );
    });

    it('deve rejeitar DISABLE_THROTTLE com valor diferente de "true"/"false"', () => {
      expect(() => validateEnv({ ...minimalEnv, DISABLE_THROTTLE: 'yes' })).toThrow(/DISABLE_THROTTLE/);
    });
  });
});
