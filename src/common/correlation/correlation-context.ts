import { AsyncLocalStorage } from 'node:async_hooks';

/** O que o contexto carrega. Só leitura: o id é definido UMA vez, na borda (middleware), e nunca reescrito. */
export interface CorrelationStore {
  readonly correlationId: string;
}

/**
 * Contexto de correlação por requisição, via `AsyncLocalStorage`.
 *
 * O ALS acompanha a cadeia assíncrona (promises, `await`, callbacks) iniciada dentro de `run()`. Assim, qualquer
 * código chamado durante a requisição (controller, handler CQRS, projeção, logger) lê o MESMO id sem receber
 * parâmetro, e duas requisições simultâneas nunca enxergam o id uma da outra.
 *
 * Por que um ALS próprio e não o do `nestjs-pino`: o de lá guarda o *logger*, não o contexto, e só existe dentro
 * de uma requisição HTTP. O id também vai ser lido por código sem HTTP (gravação de eventos, worker, consumers),
 * que não deve depender da biblioteca de log. Por isso o módulo também não é um provider do Nest: funções puras
 * funcionam dentro e fora da injeção de dependência.
 */
const storage = new AsyncLocalStorage<CorrelationStore>();

/** Executa `fn` (e tudo o que ela disparar de forma assíncrona) com o `correlationId` informado. */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** O `correlationId` da execução atual, ou `undefined` fora de um `runWithCorrelationId` (ex.: boot da app). */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
