const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'large-file.txt');

console.log('[*] Iniciando leitura com STREAMS (processa em pedaços)...');

const inicio = Date.now();
const memoriaAntes = process.memoryUsage().heapUsed / 1024 / 1024;
let totalBytes = 0;

// ✅ A SOLUÇÃO: createReadStream lê pedaços de 64KB por vez
const readStream = fs.createReadStream(filePath);

readStream.on('data', (chunk) => {
  // 'chunk' é um Buffer de ~64KB
  totalBytes += chunk.length;
});

readStream.on('end', () => {
  const memoriaDepois = process.memoryUsage().heapUsed / 1024 / 1024;
  
  console.log(`[OK] Leitura concluída em ${Date.now() - inicio}ms`);
  console.log(`[!] Memória usada pelo Node.js: ${(memoriaDepois - memoriaAntes).toFixed(2)} MB`);
  console.log(`[!] Tamanho total lido: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
});