import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';

/**
 * Rota raiz, herdada do scaffold do NestJS.
 *
 * Mantida porque é o alvo do smoke test de carga (`test/load/k6-smoke.js`, Módulo 10): um endpoint sem banco
 * nem autenticação, que mede o custo mínimo do pipeline HTTP. Pública de propósito.
 *
 * Próximo passo natural: trocá-la por um health check real (`@nestjs/terminus`, com `/health/live` e
 * `/health/ready` checando o banco), usado por orquestradores e load balancers.
 */
@ApiTags('app')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Rota raiz', description: 'Responde um texto fixo. Usada como alvo de smoke tests de carga.' })
  @ApiResponse({ status: 200, description: 'A API está de pé.', schema: { type: 'string', example: 'Hello World!' } })
  getHello(): string {
    return this.appService.getHello();
  }
}
