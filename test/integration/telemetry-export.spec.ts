/**
 * A telemetria SAI do processo (Módulo 01; migração do OpenTelemetry 2 → 3 no Módulo 03).
 *
 * Protege o que nenhum outro teste vê: telemetria quebrada não derruba a API nem reprova uma suíte, só deixa o
 * painel vazio e os alertas mudos, justamente quando mais se precisa deles. Os testes de tracing usam spans em
 * memória (`in-memory-tracing.ts`) e os de métricas, um `MeterProvider` próprio; nenhum roda o `startTelemetry` real.
 * Este roda, num processo filho (`support/telemetry-child.ts`), e prova as três saídas:
 *
 *   1. o span chega ao destino OTLP (`POST /v1/traces`), num servidor HTTP falso no lugar do Jaeger;
 *   2. o `/metrics` responde com uma métrica criada no processo;
 *   3. o `/metrics` responde pelo IP da interface de rede, e não só pelo loopback: dentro de um container, o
 *      Prometheus chega por esse IP. O OTel 3 mudou o padrão do exporter para `localhost`; o nosso `host: '0.0.0.0'`
 *      explícito é o que mantém a coleta funcionando.
 *
 * Mutações conferidas na migração: com o `metricReader` singular (removido no OTel 3), o item 2 falha; com
 * `host: 'localhost'`, o item 3 falha.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const PROBE_SPAN = 'telemetry-export-probe';
const PROBE_METRIC = 'telemetry_export_probe';

/** Um IPv4 de interface de rede (não loopback): o caminho por onde o Prometheus chegaria num container. */
function externalIPv4(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((i) => i?.family === 'IPv4' && !i.internal)?.address;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timeout esperando a telemetria');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('telemetria exportada pelo startTelemetry real (processo filho)', () => {
  let otlp: Server;
  const traceBodies: Buffer[] = [];
  let child: ChildProcess;
  let childOutput = '';
  let metricsPort: number;

  beforeAll(async () => {
    // O "Jaeger": guarda o corpo (protobuf) de cada POST /v1/traces
    otlp = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/v1/traces') traceBodies.push(Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
      });
    });
    await new Promise<void>((resolve) => otlp.listen(0, '127.0.0.1', resolve));
    const otlpPort = (otlp.address() as AddressInfo).port;
    metricsPort = await freePort();

    child = spawn(process.execPath, ['-r', 'ts-node/register', join(__dirname, 'support', 'telemetry-child.ts')], {
      cwd: ROOT,
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: 'true',
        OTEL_SDK_DISABLED: 'false',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otlpPort}`,
        // O lote de spans sai em 200 ms, e não nos 5 s padrão
        OTEL_BSP_SCHEDULE_DELAY: '200',
        TELEMETRY_TEST_METRICS_PORT: String(metricsPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => (childOutput += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (childOutput += d.toString()));
    await eventually(async () => (childOutput.includes('telemetry-child-ready') ? true : undefined), 60_000);
  });

  afterAll(async () => {
    child?.kill('SIGKILL');
    await new Promise<void>((resolve) => otlp.close(() => resolve()));
  });

  it('o span chega ao destino OTLP (POST /v1/traces)', async () => {
    await eventually(async () => (traceBodies.some((b) => b.includes(PROBE_SPAN)) ? true : undefined));
  });

  it('o /metrics responde com a métrica criada no processo', async () => {
    const body = await eventually(async () => {
      const text = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
      return text.includes(PROBE_METRIC) ? text : undefined;
    });
    expect(body).toContain('service_name="telemetry-export-test"');
  });

  const ip = externalIPv4();
  (ip ? it : it.skip)(`o /metrics responde pelo IP da interface de rede (${ip ?? 'sem interface'}), não só no loopback`, async () => {
    const res = await fetch(`http://${ip}:${metricsPort}/metrics`, { signal: AbortSignal.timeout(3_000) });
    expect(res.status).toBe(200);
  });
});
