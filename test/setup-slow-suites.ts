/**
 * Timeout das suítes que usam Testcontainers (integração e E2E): testes E hooks.
 *
 * Por que aqui e não em `testTimeout` no jest.config.ts? Porque `testTimeout` declarado DENTRO de
 * `projects` é ignorado pelo Jest (vale só no nível global) — verificado empiricamente: um hook de
 * 5,5 s estourava o default de 5 s mesmo com `testTimeout: 60_000` no projeto.
 * jest.setTimeout() em setupFilesAfterEnv, por outro lado, vale por projeto.
 *
 * Os unitários ficam com o default (5 s) de propósito: unitário lento é bug e deve falhar rápido.
 */
jest.setTimeout(60_000);
