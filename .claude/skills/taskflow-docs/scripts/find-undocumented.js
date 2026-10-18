#!/usr/bin/env node
/**
 * Lista arquivos SEM nenhum bloco de documentação — o inventário da lacuna antes (e a prova depois) de um lote.
 *
 * Critério deliberadamente simples: TS/JS sem nenhum `/**` ou `/*`; HCL/shell/YAML sem nenhum `#`.
 * Não mede QUALIDADE (isso é leitura humana) — só garante que nenhum arquivo ficou esquecido.
 * Ignora node_modules, dist, coverage, .terraform, arquivos gerados conhecidos e `.d.ts`.
 *
 * Uso: node find-undocumented.js src test terraform
 */
const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set(['node_modules', 'dist', 'coverage', '.terraform', '.git', 'generated']);
const IGNORE_FILES = new Set(['.terraform.lock.hcl', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const SLASH = /\.(ts|tsx|js|mjs|cjs|jsx)$/;
const HASH = /\.(tf|hcl|sh|ya?ml|py)$/;

const roots = process.argv.slice(2);
if (!roots.length) roots.push('.');

const missing = [];
let scanned = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(full);
      continue;
    }
    if (IGNORE_FILES.has(entry.name) || entry.name.endsWith('.d.ts')) continue;
    const isSlash = SLASH.test(entry.name);
    const isHash = HASH.test(entry.name);
    if (!isSlash && !isHash) continue;
    scanned++;
    const text = fs.readFileSync(full, 'utf8');
    const documented = isSlash ? /\/\*/.test(text) : /^\s*#/m.test(text);
    if (!documented) missing.push(full);
  }
}

roots.forEach((r) => fs.existsSync(r) && walk(r));
missing.forEach((f) => console.log(f));
console.log(`\n${missing.length} de ${scanned} arquivos sem documentação.`);
process.exitCode = missing.length ? 1 : 0;
