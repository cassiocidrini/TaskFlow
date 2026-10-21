/**
 * `npm run setup` — leva um clone novo a um ambiente pronto, igual em Windows, Linux e macOS.
 *
 * Por que Node e não Bash/PowerShell/Makefile: o Node já é pré-requisito do projeto e roda igual nos três
 * sistemas; o `make` não vem no Windows e o Bash não roda no PowerShell. Substitui o antigo `setup.ps1`.
 *
 * Só usa módulos NATIVOS (`node:*`): este script roda ANTES do `npm ci`, quando não há `node_modules`.
 *
 * Idempotente: rodar de novo não estraga nada. O `.env` existente nunca é sobrescrito (ele pode ter segredos
 * locais), `npm ci` reinstala do lockfile, e `prisma migrate deploy` só aplica migrações pendentes.
 *
 * De propósito, NÃO há fallback para `prisma migrate dev` quando o deploy falha (o `setup.ps1` tinha):
 * `migrate dev` CRIA uma migração nova a partir do schema, o que esconderia a causa do erro e deixaria um
 * arquivo novo no repositório. Falhar alto, com a mensagem real, é mais seguro.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

/** Executa um comando mostrando a saída; aborta o setup se ele falhar. */
function run(step, command) {
  console.log(`\n[${step}] ${command}`);
  // shell: true para resolver `npm`/`npx` no Windows (são .cmd). Os comandos são fixos, sem entrada externa.
  const result = spawnSync(command, { shell: true, stdio: 'inherit' });
  if (result.status !== 0) fail(`"${command}" falhou (exit ${result.status ?? 'desconhecido'}).`);
}

function fail(message) {
  console.error(`\n[X] ${message}`);
  process.exit(1);
}

// 1. Node: a versão exigida vem do `engines` do package.json (fonte única, também lida pelo npm)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const requiredMajor = Number(/\d+/.exec(pkg.engines?.node ?? '')?.[0]);
const currentMajor = Number(process.versions.node.split('.')[0]);
if (currentMajor < requiredMajor) {
  fail(`Node ${process.versions.node} encontrado; o projeto exige Node ${requiredMajor}+ (veja .nvmrc).`);
}
console.log(`[1/6] Node ${process.versions.node} OK`);

// 2. Docker: o daemon precisa estar rodando (Docker Desktop no Windows/macOS, serviço no Linux)
const docker = spawnSync('docker info', { shell: true, stdio: 'ignore' });
if (docker.status !== 0) fail('Docker não está rodando. Inicie o Docker (Desktop ou serviço) e rode de novo.');
console.log('[2/6] Docker OK');

// 3. .env: criado a partir do exemplo só se não existir — nunca sobrescreve segredos locais
if (existsSync('.env')) {
  console.log('[3/6] .env já existe (mantido)');
} else {
  copyFileSync('.env.example', '.env');
  console.log('[3/6] .env criado a partir de .env.example');
}

run('4/6', 'npm ci');
// `--wait` usa o healthcheck do compose: só segue quando o Postgres aceita conexões
run('5/6', 'npm run infra:up');
run('6/6', 'npx prisma generate && npx prisma migrate deploy');

console.log('\n[OK] Ambiente pronto. Próximo passo: npm run dev  →  http://localhost:3000/docs\n');
