/**
 * Smoke test da imagem de produção (Etapa E.1, Módulo 03): `npm run docker:smoke`, igual no CI e na sua máquina.
 *
 * Por que existe: o Dockerfile ficou no Node 20, rodando como root e copiando o `.env` para o build, e ninguém
 * percebeu, porque NADA construía nem rodava a imagem. Arquivo que nada executa apodrece em silêncio. Este teste
 * constrói a imagem e prova, num Postgres vazio, as propriedades que o Dockerfile promete:
 *
 *   1. o target `migrate` aplica as migrações (a migração é um passo separado, não o boot da API);
 *   2. a API fica `healthy` pelo HEALTHCHECK, e o `/health/ready` responde 200 (o banco está acessível);
 *   3. o processo roda como uid 1000, sem escrita no próprio código e sem npm no runtime;
 *   4. o `docker stop` faz graceful shutdown: exit 0, bem antes do SIGKILL dos 10 s.
 *
 * Tudo numa rede Docker própria, com nomes únicos, e removido no fim (inclusive se falhar). Só usa módulos nativos
 * do Node, como os scripts de `scripts/dev/`.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const id = `taskflow-smoke-${process.pid}`;
const image = `${id}:runtime`;
const migrateImage = `${id}:migrate`;
const network = `${id}-net`;
const db = `${id}-db`;
const api = `${id}-api`;
// Mesma versão do Postgres do compose e do Testcontainers (test/support/postgres-image.ts)
const POSTGRES_IMAGE = 'postgres:16.15';
const DATABASE_URL = `postgresql://smoke:smoke@${db}:5432/smoke`;
const STOP_LIMIT_S = 5;

/** Roda o docker e devolve a saída; `check: false` para comandos que PODEM falhar (o teste decide). */
function docker(args, { check = true, quiet = false } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'inherit'] });
  if (check && r.status !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} falhou (exit ${r.status})\n${r.stderr ?? ''}`);
  }
  return { status: r.status, out: (r.stdout ?? '').trim() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '[OK]  ' : '[FALHA]'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

async function waitFor(name, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await sleep(1000);
  }
  throw new Error(`timeout esperando ${name}`);
}

function cleanup() {
  docker(['rm', '-f', api, db], { check: false, quiet: true });
  docker(['network', 'rm', network], { check: false, quiet: true });
  docker(['rmi', '-f', image, migrateImage], { check: false, quiet: true });
}

async function main() {
  console.log('Construindo a imagem (runtime e migrate)...');
  docker(['build', '-q', '-t', image, '.']);
  docker(['build', '-q', '--target', 'migrate', '-t', migrateImage, '.']);

  docker(['network', 'create', network], { quiet: true });
  docker(['run', '-d', '--name', db, '--network', network,
    '-e', 'POSTGRES_USER=smoke', '-e', 'POSTGRES_PASSWORD=smoke', '-e', 'POSTGRES_DB=smoke',
    '--health-cmd', 'pg_isready -U smoke', '--health-interval', '1s', POSTGRES_IMAGE], { quiet: true });
  await waitFor('o Postgres', () => docker(['inspect', '-f', '{{.State.Health.Status}}', db], { quiet: true }).out === 'healthy', 60_000);

  const migrate = docker(['run', '--rm', '--network', network, '-e', `DATABASE_URL=${DATABASE_URL}`, migrateImage], { check: false, quiet: true });
  check('target migrate aplica as migrações num banco vazio', migrate.status === 0 && /successfully applied/.test(migrate.out));

  docker(['run', '-d', '--name', api, '--network', network,
    '-e', `DATABASE_URL=${DATABASE_URL}`,
    '-e', `JWT_SECRET=${randomBytes(32).toString('hex')}`,
    // Sem coletor no smoke: o exporter só registraria falhas de envio
    '-e', 'OTEL_SDK_DISABLED=true',
    image], { quiet: true });
  const health = () => docker(['inspect', '-f', '{{.State.Health.Status}}', api], { check: false, quiet: true }).out;
  await waitFor('a API ficar healthy', () => health() === 'healthy' || health() === 'unhealthy', 90_000);
  check('HEALTHCHECK: a API fica healthy', health() === 'healthy');

  const exec = (...cmd) => docker(['exec', api, ...cmd], { check: false, quiet: true });
  const ready = exec('node', '-e', "fetch('http://127.0.0.1:3000/health/ready').then(r=>console.log(r.status))");
  check('/health/ready responde 200 (banco acessível)', ready.out === '200', ready.out);
  const uid = exec('id', '-u').out;
  check('processo roda como uid 1000 (não root)', uid === '1000', `uid ${uid}`);
  check('sem escrita no próprio código (dist/)', exec('touch', 'dist/escrita').status !== 0);
  check('sem npm no runtime', exec('sh', '-c', 'command -v npm').status !== 0);

  const started = Date.now();
  docker(['stop', api], { quiet: true });
  const seconds = (Date.now() - started) / 1000;
  const exitCode = docker(['inspect', '-f', '{{.State.ExitCode}}', api], { quiet: true }).out;
  const drained = docker(['logs', api], { check: false, quiet: true }).out.includes('Encerramento iniciado (SIGTERM)');
  check(`docker stop: graceful shutdown, exit 0 em menos de ${STOP_LIMIT_S} s`,
    exitCode === '0' && seconds < STOP_LIMIT_S && drained, `exit ${exitCode}, ${seconds.toFixed(2)} s`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  failures++;
} finally {
  cleanup();
}
console.log(failures === 0 ? '\nImagem OK.' : `\n${failures} verificação(ões) falharam.`);
process.exit(failures === 0 ? 0 : 1);
