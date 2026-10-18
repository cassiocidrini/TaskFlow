/**
 * Gera `test/load/large-file.txt` (~100 MB) para os experimentos de Streams (Módulo 11).
 * O arquivo gerado é ignorado pelo Git (`.gitignore`): versiona-se o script que gera, nunca o artefato.
 *
 * ⚠️ Exemplo NEGATIVO de backpressure: chama `write()` em loop SEM checar o retorno, então os 100 MB ficam
 * enfileirados na memória antes de chegar ao disco. O certo: esperar o evento `drain` quando `write()` devolve
 * `false`, ou usar `stream.pipeline()`.
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'large-file.txt');
const writeStream = fs.createWriteStream(filePath);

console.log('[*] Gerando arquivo de ~100MB...');

// Escreve 100 vezes um bloco de 1MB
for (let i = 0; i < 100; i++) {
  // Um bloco de 1MB cheio de letras 'A'
  writeStream.write('A'.repeat(1024 * 1024));
}

writeStream.end();

writeStream.on('finish', () => {
  const stats = fs.statSync(filePath);
  console.log(`[OK] Arquivo criado: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
});