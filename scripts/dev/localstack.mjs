/**
 * Ambiente AWS local (LocalStack + Terraform, Módulo 09), igual em Windows, Linux e macOS.
 *
 *   npm run aws:up         sobe o LocalStack, cria o bucket do state e aplica o Terraform
 *   npm run aws:down       remove o LocalStack e o volume dele (recursos E state somem juntos)
 *   npm run aws:recreate   down + up
 *   npm run aws:resources  lista filas SQS e buckets S3 criados
 *
 * Substitui `terraform-setup.ps1`, `terraform-clean.ps1`, `terraform-recreate.ps1` e `checkResources.ps1`.
 * Na migração, dois bugs dos scripts antigos foram corrigidos:
 * - O clean apagava o `terraform/.terraform.lock.hcl`, que é VERSIONADO (fixa as versões dos providers,
 *   como o package-lock do npm). Aqui só sai o cache `.terraform/`.
 * - Falhas do Terraform viravam "[OK]": o `try/catch` do PowerShell não captura erro de executável externo e
 *   a saída ia para `Out-Null`. Aqui a saída aparece e o exit code é checado.
 *
 * Não há `terraform destroy` no `down`: o state vive no S3 do PRÓPRIO LocalStack (`terraform/backend.tf`), então
 * apagar o volume remove recursos e state de uma vez. (O destroy antigo só rodava se houvesse state LOCAL, o que
 * nunca acontecia com o backend remoto.) Só usa módulos nativos do Node, como o `setup.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const STATE_BUCKET = 'taskflow-terraform-state';
const REQUIRED_SERVICES = ['sqs', 's3', 'dynamodb', 'sns', 'iam'];

/** Executa mostrando a saída; aborta se falhar (a menos que `allowFailure`). Devolve o exit code. */
function run(command, { allowFailure = false, quiet = false } = {}) {
  if (!quiet) console.log(`\n> ${command}`);
  // shell: true para resolver executáveis no Windows; os comandos são fixos, sem entrada externa.
  const { status } = spawnSync(command, { shell: true, stdio: quiet ? 'ignore' : 'inherit' });
  if (status !== 0 && !allowFailure) fail(`"${command}" falhou (exit ${status ?? 'desconhecido'}).`);
  return status;
}

function fail(message) {
  console.error(`\n[X] ${message}`);
  process.exit(1);
}

/** Nome real do volume: o Compose prefixa com o nome do projeto, que muda conforme a pasta do clone. */
function localstackVolumeName() {
  const { status, stdout } = spawnSync('docker compose config --format json', { shell: true, encoding: 'utf8' });
  if (status !== 0) fail('Não foi possível ler o docker-compose.yml (o Docker está rodando?).');
  return JSON.parse(stdout).volumes.localstack_data.name;
}

async function up() {
  if (run('docker info', { quiet: true, allowFailure: true }) !== 0) fail('Docker não está rodando.');
  if (run('terraform -version', { quiet: true, allowFailure: true }) !== 0) {
    fail('Terraform não encontrado no PATH (https://developer.hashicorp.com/terraform/install).');
  }

  // A imagem do LocalStack tem HEALTHCHECK próprio: `--wait` substitui o loop de 30 tentativas do .ps1
  run('docker compose up -d --wait localstack');

  // "healthy" diz que o gateway responde; cada serviço AWS ainda precisa estar disponível
  const { services } = await (await fetch('http://localhost:4566/_localstack/health')).json();
  const missing = REQUIRED_SERVICES.filter((s) => !['available', 'running'].includes(services[s]));
  if (missing.length) fail(`Serviços do LocalStack indisponíveis: ${missing.join(', ')}.`);
  console.log(`[OK] Serviços disponíveis: ${REQUIRED_SERVICES.join(', ')}`);

  // O bucket do state precisa existir ANTES do `terraform init` (o backend não o cria): idempotente
  const exists = run(`docker compose exec -T localstack awslocal s3api head-bucket --bucket ${STATE_BUCKET}`, {
    quiet: true,
    allowFailure: true,
  });
  if (exists === 0) console.log(`[OK] Bucket ${STATE_BUCKET} já existe`);
  else run(`docker compose exec -T localstack awslocal s3 mb s3://${STATE_BUCKET}`);

  run('terraform -chdir=terraform init -reconfigure -input=false');
  run('terraform -chdir=terraform apply -auto-approve -input=false'); // o apply já imprime os outputs
  console.log('\n[OK] Infraestrutura AWS local aplicada. Veja: npm run aws:resources\n');
}

function down() {
  // `rm --stop --force` age só no LocalStack; `docker compose down` derrubaria também o Postgres e o resto
  run('docker compose rm --stop --force localstack');
  const volume = localstackVolumeName();
  run(`docker volume rm ${volume}`, { allowFailure: true }); // já removido = ok
  rmSync('terraform/.terraform', { recursive: true, force: true }); // cache de providers/backend, não versionado
  console.log(`\n[OK] LocalStack, volume ${volume} e cache .terraform/ removidos (lock file mantido).\n`);
}

function resources() {
  console.log('=== Filas SQS ===');
  run('docker compose exec -T localstack awslocal sqs list-queues');
  console.log('\n=== Buckets S3 ===');
  run('docker compose exec -T localstack awslocal s3 ls');
}

async function recreate() {
  down();
  await up();
}

const commands = { up, down, recreate, resources };
const command = commands[process.argv[2]];
if (!command) fail(`Uso: node scripts/dev/localstack.mjs <${Object.keys(commands).join('|')}>`);
await command();
