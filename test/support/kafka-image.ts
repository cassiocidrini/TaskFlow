/**
 * Imagem do Kafka da suíte `test:streaming`. Precisa ser a MESMA tag do serviço `kafka` do `docker-compose.yml`:
 * o teste prova o contrato com o broker que o desenvolvimento usa (mesma lógica do `postgres-image.ts`).
 * Atualizar a versão = trocar aqui E no compose, no mesmo PR.
 */
export const KAFKA_TEST_IMAGE = 'apache/kafka:4.3.2';
