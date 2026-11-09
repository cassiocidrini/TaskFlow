/**
 * Reconhece as rotas de probe (`/health`, `/health/live`, `/health/ready`, com ou sem query string).
 *
 * Arquivo SEM imports, de propósito: é usado pelo `tracing.ts`, que roda antes de qualquer biblioteca ser carregada
 * (ver "Ordem crítica" no AGENTS.md), e pelo logger. Os probes chegam a cada poucos segundos e ficam FORA do log de
 * acesso, dos traces e das métricas HTTP: respostas de 1 ms em volume constante puxariam o p50 para baixo e
 * inflariam o req/s, escondendo a latência real dos clientes.
 */
export function isHealthCheck(url: string | undefined): boolean {
  if (!url) return false;
  return url === '/health' || url.startsWith('/health/') || url.startsWith('/health?');
}
