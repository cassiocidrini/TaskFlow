import { Module } from '@nestjs/common';
import { IdempotencyKeysCleaner } from './idempotency-keys.cleaner';
import { IdempotencyStore } from './idempotency.store';

/**
 * Idempotência das requisições que criam recursos (Módulo 14.5). Hoje só o `POST /tasks` usa; outro endpoint de
 * criação importa este módulo e segue a mesma receita (hash do pedido, `alsoWrite` na transação do efeito).
 */
@Module({
  providers: [IdempotencyStore, IdempotencyKeysCleaner],
  exports: [IdempotencyStore],
})
export class IdempotencyModule {}
