#!/usr/bin/env node
/**
 * Sobe a app compilada numa porta livre, lê o documento OpenAPI gerado e imprime uma linha por rota:
 *   MÉTODO  caminho  🔒(exige token)  [tags]  summary | status  (* = resposta com schema tipado)
 *
 * Por que olhar o JSON gerado e não o código: o plugin do Swagger e os decorators só se combinam no build —
 * o que o consumidor vê é o artefato. Este probe pega tag "fantasma", cadeado em rota pública e status faltando.
 *
 * Uso: node probe-openapi.js [--entry dist/main.js] [--port 3999] [--path /docs-json] [filtro]
 *   filtro: substring do caminho (sem barra inicial no Git Bash do Windows, que converte "/x" em caminho de disco).
 */
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const entry = opt('entry', 'dist/main.js');
const port = opt('port', '3999');
const docsPath = opt('path', '/docs-json');
const filter = args[0] || '';

const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: port }, stdio: 'ignore' });
const deadline = Date.now() + 30_000;

(async function poll() {
  try {
    const doc = await (await fetch(`http://localhost:${port}${docsPath}`)).json();
    const declared = new Set((doc.tags || []).map((t) => t.name));
    const used = new Set();
    for (const [path, ops] of Object.entries(doc.paths || {})) {
      if (!path.includes(filter)) continue;
      for (const [method, op] of Object.entries(ops)) {
        (op.tags || []).forEach((t) => used.add(t));
        const codes = Object.entries(op.responses || {})
          .map(([code, r]) => code + (r.content ? '*' : ''))
          .join(' ');
        const lock = op.security && op.security.length ? '🔒' : '  ';
        console.log(
          `${method.toUpperCase().padEnd(6)} ${path.padEnd(48)} ${lock} [${(op.tags || []).join(',')}] ` +
            `${op.summary || '(sem summary)'} | ${codes}`,
        );
      }
    }
    console.log('\ntags declaradas:', [...declared].join(', ') || '(nenhuma)');
    const ghosts = [...used].filter((t) => !declared.has(t));
    if (ghosts.length) console.log('⚠ tags usadas mas não declaradas (seção duplicada?):', ghosts.join(', '));
  } catch (e) {
    if (Date.now() < deadline) return setTimeout(poll, 500);
    console.log('FALHOU ao ler', docsPath, '-', e.message);
    process.exitCode = 1;
  }
  child.kill();
})();
