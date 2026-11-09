import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DatabaseHealthIndicator } from './database.health';
import { ShutdownState } from './shutdown-state';

/**
 * Probes para o orquestrador (Docker, Kubernetes, ECS, load balancer). Públicos de propósito: probe não autentica.
 *
 * Liveness e readiness respondem perguntas DIFERENTES, e misturá-las é um erro clássico:
 * - **live:** "o processo está vivo?". Falha = o orquestrador REINICIA o container. Por isso não consulta o banco:
 *   com o Postgres fora do ar, todas as réplicas falhariam juntas e seriam reiniciadas em massa (*restart storm*),
 *   sem resolver nada.
 * - **ready:** "posso receber tráfego agora?". Falha = a réplica sai do balanceador, mas continua viva. Consulta o
 *   banco e o estado de encerramento.
 *
 * `@SkipThrottle`: o probe roda a cada poucos segundos e não pode receber 429. As duas rotas também ficam fora
 * do log de acesso (`logger.options.ts`).
 */
@ApiTags('app')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly database: DatabaseHealthIndicator,
    private readonly shutdown: ShutdownState,
  ) {}

  @Get('live')
  @HealthCheck()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Responde 200 enquanto o processo atende requisições. Não verifica dependências: uma falha aqui faz o ' +
      'orquestrador reiniciar o container, o que não resolveria um banco fora do ar.',
  })
  live() {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      '200 quando a réplica pode receber tráfego: PostgreSQL respondendo (`SELECT 1` em até 1 s) e app fora de ' +
      'encerramento. 503 caso contrário; o orquestrador tira a réplica do balanceador sem reiniciá-la. A resposta ' +
      'traz só `up`/`down` por dependência, sem detalhes de infraestrutura.',
  })
  ready() {
    return this.health.check([
      () => {
        const indicator = this.indicators.check('shutdown');
        return this.shutdown.isDraining() ? indicator.down() : indicator.up();
      },
      () => this.database.pingCheck('database'),
    ]);
  }
}
