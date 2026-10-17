const autocannon = require('autocannon');

async function main() {
  console.log('[*] Teste de debug: 5 requisicoes POST /auth/register\n');

  let counter = 0;

  const result = await autocannon({
    url: 'http://localhost:3000/auth/register',
    connections: 1,          // 1 conexao para facilitar debug
    amount: 5,               // 5 requisicoes apenas
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'placeholder@test.com',
      name: 'Placeholder',
      password: 'senha12345',
    }),
    setupRequest: (req) => {
      counter++;
      const body = JSON.stringify({
        email: `debug-${counter}-${Date.now()}@test.com`,
        name: 'Debug',
        password: 'senha12345',
      });
      req.body = body;
      return req;
    },
    onResponse: (statusCode, body, res, context) => {
      console.log(`  [resp] status=${statusCode} | body=${body.toString().substring(0, 200)}`);
    },
  });

  console.log(`\n=== Resultado ===`);
  console.log(`Requests:   ${result.requests.total}`);
  console.log(`Non-2xx:    ${result.non2xx}`);
  console.log(`Erros:      ${result.errors}`);
}

main().catch(console.error);