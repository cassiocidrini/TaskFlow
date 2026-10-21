/**
 * Imagem do PostgreSQL usada por TODAS as suítes com Testcontainers (integração e E2E).
 *
 * Precisa ser a MESMA tag do serviço `postgres` do `docker-compose.yml`. Os testes de integração existem para
 * provar contratos com o banco, e um banco diferente do de desenvolvimento prova o contrato errado:
 * - **Tag fixa, não `16-alpine`:** tag móvel deixa um patch novo do Postgres entrar nos testes sem decisão.
 * - **Debian, não Alpine:** a variante Alpine usa a musl libc, cujo suporte a locale é limitado. A ordenação
 *   de texto (`ORDER BY` em colunas `text`) pode diferir da imagem Debian usada no dev e em produção.
 *
 * Custo aceito: a imagem Debian é maior (~150 MB a mais), alguns segundos de download por job no CI.
 * Atualizar a versão = trocar aqui E no compose, no mesmo PR.
 */
export const POSTGRES_TEST_IMAGE = 'postgres:16.15';
