/**
 * Imagem do Prometheus usada para testar as regras de alerta. Precisa ser a MESMA tag do serviço `prometheus` do
 * `docker-compose.yml`: a PromQL e o `promtool` mudam entre versões (o Prometheus 3 mudou a borda das janelas), e o
 * teste tem de valer para o Prometheus que avalia os alertas. O próprio teste confere a tag no compose.
 */
export const PROMETHEUS_TEST_IMAGE = 'prom/prometheus:v3.15.0';
