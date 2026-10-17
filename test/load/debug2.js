const autocannon = require('autocannon');

async function main() {
  console.log('[*] Teste com body ESTATICO (sem setupRequest)\n');

  const result = await autocannon({
    url: 'http://localhost:3000/auth/register',
    connections: 1,
    amount: 1,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: `estatico-${Date.now()}@test.com`,
      name: 'Estatico',
      password: 'senha12345',
    }),
  });

  console.log(`Requests:   ${result.requests.total}`);
  console.log(`Non-2xx:    ${result.non2xx}`);
  console.log(`Erros:      ${result.errors}`);
  console.log(`Timeouts:   ${result.timeouts}`);

  // Mostra os detalhes das respostas
  if (result.statusCodeStats) {
    console.log('\nStatus codes:');
    for (const [code, stats] of Object.entries(result.statusCodeStats)) {
      console.log(`  ${code}: ${stats.count}`);
    }
  }
}

main().catch(console.error);