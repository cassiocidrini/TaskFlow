const autocannon = require('autocannon');

async function main() {
  console.log('[*] Rodando smoke test: GET / por 10s com 10 conexoes...\n');

  const result = await autocannon({
    url: 'http://localhost:3000',
    connections: 10,
    duration: 10,
    method: 'GET',
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