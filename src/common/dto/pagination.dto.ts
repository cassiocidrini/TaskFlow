import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Paginação por cursor (*keyset pagination*): `?limit=20&cursor=<id do último item da página anterior>`.
 *
 * Por que cursor, e não offset (`?page=N`)?
 * - **Performance:** no offset, a página 1000 obriga o banco a LER e DESCARTAR 20 mil linhas; o cursor
 *   vai direto ao ponto pelo índice, com custo constante.
 * - **Estabilidade:** com offset, uma tarefa criada durante a navegação desloca as páginas, e itens se
 *   repetem ou somem. O cursor é imune a isso.
 *
 * É o mesmo modelo de Stripe, Slack e GitHub — e o único que o DynamoDB oferece (`ExclusiveStartKey`).
 */
export class CursorPaginationDto {
  /**
   * O cliente escolhe o tamanho; o SERVIDOR impõe o teto. Sem `@Max`, um `?limit=1000000` faria uma
   * única requisição carregar a tabela inteira na memória do Node e do Postgres
   * (OWASP API4 — Unrestricted Resource Consumption).
   */
  @ApiPropertyOptional({
    description: `Itens por página (1–${MAX_PAGE_SIZE})`,
    default: DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    example: 20,
  })
  @IsOptional()
  // Query string sempre chega como texto ("20"). A conversão é declarada AQUI, e não só no
  // enableImplicitConversion global, para o DTO funcionar em qualquer configuração (ex.: testes).
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({
    description: 'Valor de `nextCursor` devolvido pela página anterior. Omita para buscar a primeira página.',
    format: 'uuid',
    example: '370b268e-18ba-444c-ae17-2716b0269232',
  })
  @IsOptional()
  @IsUUID('4')
  cursor?: string;
}

/**
 * Envelope padrão de resposta paginada.
 *
 * Genérico em TypeScript; para o Swagger, cada listagem declara uma classe concreta com o tipo dos itens
 * (ex.: `TaskPageDto`), porque genéricos não existem em runtime.
 */
export interface CursorPage<T> {
  items: T[];
  /** Passe como `?cursor=` para buscar a próxima página. `null` = não há mais páginas. */
  nextCursor: string | null;
}
