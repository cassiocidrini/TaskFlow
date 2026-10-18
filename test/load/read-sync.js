const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'large-file.txt');

console.log('[*] Iniciando leitura SÍNCRONA (carrega tudo na memória)...');

const inicio = Date.now();
const memoriaAntes = process.memoryUsage().heapUsed / 1024 / 1024;

// ❌ O PECADO CAPITAL: readFileSync carrega 100MB na RAM de uma vez
const conteudo = fs.readFileSync(filePath, 'utf-8');

const memoriaDepois = process.memoryUsage().heapUsed / 1024 / 1024;

console.log(`[OK] Leitura concluída em ${Date.now() - inicio}ms`);
console.log(`[!] Memória usada pelo Node.js: ${(memoriaDepois - memoriaAntes).toFixed(2)} MB`);
console.log(`[!] Tamanho do conteúdo: ${(conteudo.length / 1024 / 1024).toFixed(2)} MB`);