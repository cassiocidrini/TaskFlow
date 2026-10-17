const autocannon = require('autocannon');

async function main() {
  console.log('[*] Rodando load test: POST /auth/register por 10s com 10 conexoes...\n');
  console.log('    Cada requisicao faz bcrypt (~250ms de CPU)\n');

  let counter = 0;

  const result = await autocannon({
    url: 'http://localhost:3000/auth/register',
    connections: 10,
    duration: 10,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    // ⚠️ IMPORTANTE: modificar req.body e retornar o PROPRIO req
    // NÃO criar um objeto novo com spread
    setupRequest: (req) => {
      counter++;
      req.body = JSON.stringify({
        email: `load-test-${counter}-${Date.now()}@test.com`,
        name: 'Load Test',
        password: 'senha12345',
      });
      return req;
    },
  });

  console.log('=== Resultado ===');
  console.log(`Requests:      ${result.requests.total}`);
  console.log(`Throughput:    ${result.requests.average} req/s (media)`);
  console.log(`Latencia p50:  ${result.latency.p50} ms`);
  console.log(`Latencia p75:  ${result.latency.p75} ms`);
  console.log(`Latencia p90:  ${result.latency.p90} ms`);
  console.log(`Latencia p97.5:${result.latency.p97_5} ms`);
  console.log(`Latencia p99:  ${result.latency.p99} ms`);
  console.log(`Latencia max:  ${result.latency.max} ms`);
  console.log(`Erros:         ${result.errors}`);
  console.log(`Timeouts:      ${result.timeouts}`);
  console.log(`Non-2xx:       ${result.non2xx}`);
}

main().catch(console.error);