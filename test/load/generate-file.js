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