/**
 * Carrega o `.env` para `process.env` — PRIMEIRO import do `main.ts`.
 *
 * Por que um arquivo só para isso, se o `ConfigModule` também lê o `.env`? Porque o `tracing.ts` roda ANTES
 * do Nest existir (precisa instrumentar `http`/`pg` antes de eles serem carregados) e já precisa do
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. A ordem `import './env'` → `import './tracing'` é crítica.
 *
 * O `dotenv` não sobrescreve variáveis que já existem no ambiente: em produção (ou num terminal com
 * `$env:X=...`), o ambiente real vence o arquivo.
 */
import 'dotenv/config';
