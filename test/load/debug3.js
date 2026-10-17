const autocannon = require('autocannon');

// Verificar versao instalada
const pkg = require('autocannon/package.json');
console.log(`[*] autocannon versao: ${pkg.version}\n`);

async function main() {
  console.log('[*] 5 requests POST com setupRequest dinâmico\n');

  let counter = 0;
  const responses = [];

  const result = await autocannon({
    url: 'http://localhost:3000/auth/register',
    connections: 1,
    amount: 5,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    setupRequest: (req, context) => {
      counter++;
      const body = JSON.stringify({
        email: `dbg3-${counter}-${Date.now()}@test.com`,
        name: 'Debug3',
        password: 'senha12345',
      });
      req.body = body;

      // Debug: mostra o que estamos enviando
      console.log(`  [setupRequest #${counter}] body=${body.substring(0, 80)}...`);

      return req;
    },
    onResponse: (client, statusCode, resBytes, responseTime) => {
      responses.push(statusCode);
      console.log(`  [resp] status=${statusCode} time=${responseTime}ms`);
    },
  });

  console.log(`\n=== Resultado ===`);
  console.log(`Requests:   ${result.requests.total}`);
  console.log(`Non-2xx:    ${result.non2xx}`);
  console.log(`Status codes recebidos: ${responses.join(', ')}`);
}

main().catch(console.error);