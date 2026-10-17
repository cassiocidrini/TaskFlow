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