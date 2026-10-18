/**
 * Roda ANTES de cada arquivo de teste (setupFiles), em todos os projects do Jest.
 *
 * `DISABLE_THROTTLE=true`: sem isso, os E2E receberiam 429 — o rate limit (100/min; 3/min no cadastro) é real.
 * O guard continua registrado e só deixa de bloquear (`skipIf` no AppModule): a estrutura da app é a mesma da produção.
 */
process.env.DISABLE_THROTTLE = 'true';
process.env.NODE_ENV = 'test';