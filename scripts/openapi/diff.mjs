/**
 * Mudanças INCOMPATÍVEIS no contrato da API (Módulo 14.3), com o oasdiff, contra a `main`:
 *
 *   npm run openapi:diff                          compara docs/api/openapi.json com o da origin/main
 *   npm run openapi:diff -- --base outro.json     compara com outro arquivo (experimentos)
 *
 * O snapshot (`openapi:check`) garante que TODA mudança de contrato aparece no PR; este comando diz quais delas quebram
 * quem não atualizou: campo removido da resposta, tipo alterado, campo de entrada que virou obrigatório, rota
 * removida... São centenas de regras, e por isso uma ferramenta pronta (oasdiff), e não um comparador próprio.
 *
 * Roda pela imagem Docker, com a MESMA versão fixada do workflow `api-contract.yml`: nada para instalar, e o resultado
 * local é o mesmo do CI. Só módulos nativos do Node, como os outros scripts de `scripts/dev/`.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

/** Mesma versão do `.github/workflows/api-contract.yml`. */
const OASDIFF_IMAGE = 'tufin/oasdiff:v1.37.0@sha256:ff02af37a254b5199b9d72e7bba93dae5837a9119d59459168d1398893b47aea';
const SNAPSHOT = 'docs/api/openapi.json';

/** Devolve o código de saída; quem chama garante a limpeza da pasta temporária (`process.exit` pularia o `finally`). */
function compare(dir, base) {
  if (base) {
    copyFileSync(base, join(dir, 'base.json'));
  } else {
    spawnSync('git', ['fetch', '--quiet', 'origin', 'main'], { stdio: 'inherit' });
    const base = spawnSync('git', ['show', `origin/main:${SNAPSHOT}`], { encoding: 'utf8' });
    if (base.status !== 0) {
      console.log(`[i] A main ainda não tem ${SNAPSHOT}: não há contrato anterior para comparar.`);
      return 0;
    }
    writeFileSync(join(dir, 'base.json'), base.stdout);
  }
  copyFileSync(SNAPSHOT, join(dir, 'revision.json'));

  // Base vazia ou inválida faria o oasdiff responder "nenhuma mudança incompatível" (comparou contra nada): um falso
  // OK. Achado com uma base gerada errado num experimento (problema 7 do Módulo 14)
  for (const name of ['base.json', 'revision.json']) {
    let spec;
    try {
      spec = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      spec = undefined;
    }
    if (typeof spec?.openapi !== 'string') {
      console.error(`[X] ${name === 'base.json' ? 'A base' : 'O snapshot'} não é um documento OpenAPI válido.`);
      return 1;
    }
  }

  const result = spawnSync(
    'docker',
    ['run', '--rm', '-v', `${dir}:/specs:ro`, OASDIFF_IMAGE, 'breaking', '/specs/base.json', '/specs/revision.json', '--fail-on', 'ERR'],
    { stdio: 'inherit' },
  );
  if (result.status === 0) {
    console.log('\n[OK] Nenhuma mudança incompatível no contrato.');
  } else {
    console.error(
      '\n[X] Mudança incompatível: um app instalado que use o que mudou vai quebrar.\n' +
        '    Prefira expand/contract (acrescente o novo, mantenha o antigo, remova depois da versão mínima).\n' +
        '    Se for mesmo intencional, o PR precisa da label "breaking-change".',
    );
  }
  return result.status ?? 1;
}

const { values } = parseArgs({ options: { base: { type: 'string' } } });
const dir = mkdtempSync(join(tmpdir(), 'oasdiff-'));
try {
  process.exitCode = compare(dir, values.base);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
