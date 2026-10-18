/**
 * k6 — load test de `POST /auth/register` com SLO (Módulo 10). NÃO é teste do Jest.
 *
 * Endpoint CPU-bound (bcrypt no thread pool de 4 threads): é onde aparece o joelho da curva.
 * Os `thresholds` são SLOs executáveis: se violados, o k6 sai com código ≠ 0 e falharia um pipeline.
 *
 * Pré-requisito: `DISABLE_THROTTLE=true` (senão o teste mede o rate limit: 100% de 429).
 * Cada execução cria usuários REAIS no banco; e-mails únicos por VU/iteração evitam 409.
 * Resultados do módulo: `k6 run --vus 20 --duration 60s test/load/k6-register.js`.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '10s',
  // Thresholds: falha se o teste não cumprir esses SLOs
  thresholds: {
    http_req_failed: ['rate<0.01'],        // < 1% de erro
    http_req_duration: ['p(95)<1000'],     // p95 < 1 segundo
  },
};

export default function () {
  // Email único por VU + iteração (evita 409 Conflict)
  const email = `load-${__VU}-${__ITER}-${Date.now()}@test.com`;

  const payload = JSON.stringify({
    email,
    name: 'Load Test',
    password: 'senha12345',
  });

  const res = http.post('http://localhost:3000/auth/register', payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'status é 201': (r) => r.status === 201,
    'retorna userId': (r) => r.json('userId') !== undefined,
    'não expõe password': (r) => r.json('password') === undefined,
  });

  sleep(0.1);
}