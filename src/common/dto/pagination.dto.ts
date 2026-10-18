import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Paginação por cursor (keyset): ?limit=20&cursor=<id do último item da página anterior>
 *
 * Preferida ao offset (?page=N) porque não degrada em páginas profundas
 * e não duplica/pula itens quando novos registros são inseridos durante a navegação.
 */
export class CursorPaginationDto {
  @IsOptional()
  @Type(() => Number) // query string sempre chega como texto: "20" → 20
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE) // teto obrigatório: ninguém pede 1 milhão de linhas (OWASP API4)
  limit: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @IsUUID('4')
  cursor?: string;
}

/** Envelope padrão de resposta paginada */
export interface CursorPage<T> {
  items: T[];
  /** Passe como ?cursor= para buscar a próxima página. null = acabou. */
  nextCursor: string | null;
}
