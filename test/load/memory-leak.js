// ❌ SIMULAÇÃO DE MEMORY LEAK
// Um cache que nunca para de crescer (sem limite, sem TTL)

const cacheGlobal = []; // Variável global "presa" na memória

function processarRequisicao(id) {
  // Simula o payload de uma requisição (1KB de dados)
  const dados = { id, timestamp: Date.now(), payload: 'X'.repeat(1024) };
  
  // ❌ O LEAK: adiciona ao cache e NUNCA remove
  cacheGlobal.push(dados);
}

console.log('[*] Iniciando simulação de memory leak...');
console.log('    Observe a memória (heapUsed) crescendo a cada segundo.\n');

let iteracao = 0;
setInterval(() => {
  // Simula 100 requisições por segundo
  for (let i = 0; i < 100; i++) {
    processarRequisicao(++iteracao);
  }

  // Mostra a memória usada (em MB)
  const mb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  console.log(`[${iteracao} itens no cache] Memória: ${mb} MB`);
}, 1000);