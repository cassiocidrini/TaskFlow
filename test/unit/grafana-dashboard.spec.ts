/**
 * Dashboard do Grafana como código (`grafana/dashboards/*.json` + `grafana/provisioning/`), validado sem Docker.
 *
 * Protege contra o "No data" silencioso (problema 8 do Módulo 01: nome de métrica errado só aparecia ao abrir o
 * painel): toda consulta usa uma métrica que a API realmente expõe; todo painel aponta para o `uid` do datasource
 * provisionado; nenhum agrupamento usa label de alta cardinalidade (URL, usuário, correlação); e o dashboard é
 * somente leitura na UI, com `uid` fixo (mudança = PR).
 *
 * `KNOWN_METRICS` é a lista conferida no `/metrics` da API (porta 9464). Se uma atualização do OpenTelemetry
 * renomear uma métrica, este teste falha antes do dashboard ficar vazio em produção.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', 'grafana');

const KNOWN_METRICS = new Set([
  'http_server_request_duration',
  'db_client_operation_duration',
  'db_client_connection_count',
  'db_client_connection_max',
  'db_client_connection_pending_requests',
  'nodejs_eventloop_delay_p99',
  'nodejs_eventloop_utilization',
  'v8js_memory_heap_used',
  'v8js_gc_duration',
]);

/** Labels que explodiriam a cardinalidade se virassem dimensão de agrupamento. */
const HIGH_CARDINALITY_LABELS = ['url', 'url_full', 'http_target', 'user_id', 'userId', 'actor_id', 'correlation_id'];

interface Target {
  expr: string;
  datasource: { uid: string };
}
interface Panel {
  id: number;
  type: string;
  title: string;
  datasource?: { uid: string };
  gridPos: { x: number; w: number };
  targets?: Target[];
}

const dashboardFiles = readdirSync(join(ROOT, 'dashboards')).filter((f) => f.endsWith('.json'));
const datasourcesYaml = readFileSync(join(ROOT, 'provisioning', 'datasources', 'datasources.yml'), 'utf8');
const providedUids = new Set([...datasourcesYaml.matchAll(/^\s+uid:\s*(\S+)/gm)].map((m) => m[1]));

/**
 * Nomes de métrica numa expressão PromQL. Remove antes os seletores `{...}` e os agrupamentos `by (...)`, onde só há
 * nomes de LABEL (que têm os mesmos prefixos: `http_route`, `db_operation_name`).
 */
function metricsIn(expr: string): string[] {
  const withoutLabels = expr.replace(/\{[^}]*\}/g, '').replace(/\bby\s*\([^)]*\)/g, '');
  return withoutLabels.match(/\b(?:http|db|nodejs|v8js)_[a-z0-9_]+\b/g) ?? [];
}

/**
 * Conhecida como está (`db_client_connection_count` é um gauge com "_count" no nome) ou como série de um histograma
 * conhecido (`http_server_request_duration_bucket`).
 */
function isKnownMetric(name: string): boolean {
  return KNOWN_METRICS.has(name) || KNOWN_METRICS.has(name.replace(/_(bucket|count|sum)$/, ''));
}

describe('provisionamento do Grafana', () => {
  it('deve declarar os datasources com uid fixo', () => {
    expect(providedUids).toEqual(new Set(['taskflow-prometheus', 'taskflow-jaeger']));
  });

  it('deve existir pelo menos um dashboard', () => {
    expect(dashboardFiles.length).toBeGreaterThan(0);
  });
});

describe.each(dashboardFiles)('dashboard %s', (file) => {
  const dashboard = JSON.parse(readFileSync(join(ROOT, 'dashboards', file), 'utf8')) as {
    uid: string;
    editable: boolean;
    panels: Panel[];
  };
  const panels = dashboard.panels.filter((p) => p.type !== 'row');
  const targets = panels.flatMap((p) => (p.targets ?? []).map((t) => ({ panel: p.title, ...t })));

  it('deve ter uid fixo e ser somente leitura na UI', () => {
    expect(dashboard.uid).toMatch(/^[a-z0-9-]+$/);
    expect(dashboard.editable).toBe(false);
  });

  it('deve ter ids de painel únicos e caber na grade de 24 colunas', () => {
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of panels) {
      expect(p.gridPos.x + p.gridPos.w).toBeLessThanOrEqual(24);
    }
  });

  it('deve apontar todo painel e toda consulta para um datasource provisionado', () => {
    for (const p of panels) {
      expect(providedUids).toContain(p.datasource?.uid);
    }
    for (const t of targets) {
      expect(providedUids).toContain(t.datasource.uid);
    }
  });

  it('deve consultar só métricas que a API expõe (evita "No data")', () => {
    const unknown = targets.flatMap((t) => metricsIn(t.expr).filter((m) => !isKnownMetric(m)));
    expect(unknown).toEqual([]);
    expect(targets.every((t) => metricsIn(t.expr).length > 0)).toBe(true);
  });

  it('não deve agrupar por label de alta cardinalidade', () => {
    for (const t of targets) {
      const groupings = [...t.expr.matchAll(/\bby\s*\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
      expect(groupings.filter((label) => HIGH_CARDINALITY_LABELS.includes(label))).toEqual([]);
    }
  });
});
