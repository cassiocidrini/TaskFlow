/**
 * Experimento: cópia de arquivo com `.pipe()` (Módulo 11) — backpressure automático.
 *
 * Se a escrita for mais lenta que a leitura, o `.pipe()` PAUSA a leitura até o destino esvaziar.
 * Em código de produção, prefira `stream.pipeline()`: além do backpressure, propaga erros e fecha os streams.
 */
const fs = require('fs');
const path = require('path');

const origem = path.join(__dirname, 'large-file.txt');
const destino = path.join(__dirname, 'large-file-copia.txt');

console.log('[*] Copiando arquivo com .pipe()...');

const inicio = Date.now();

const readStream = fs.createReadStream(origem);
const writeStream = fs.createWriteStream(destino);

// O pipe gerencia o backpressure sozinho!
// Se o writeStream estiver lento, o pipe pausa o readStream.
readStream.pipe(writeStream);

writeStream.on('finish', () => {
  console.log(`[OK] Cópia concluída em ${Date.now() - inicio}ms`);
  console.log('[i] O Backpressure foi gerenciado automaticamente.');
});