import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ShutdownState } from './shutdown-state';

/**
 * Durante a drenagem, toda resposta sai com `Connection: close`.
 *
 * Balanceadores e proxies (ALB, nginx, Envoy) mantêm um POOL de conexões keep-alive com cada réplica e as reutilizam.
 * O readiness 503 tira a réplica da rotação para conexões NOVAS, mas uma conexão já aberta no pool pode continuar
 * recebendo requisições até o servidor fechá-la, e a requisição que estiver passando por ela nesse instante leva
 * `ECONNRESET`.
 *
 * Com `Connection: close`, cada conexão termina logo após a resposta em andamento, e o proxy a descarta do pool em
 * vez de reutilizá-la. Quando o servidor HTTP fecha, não sobra conexão de pool apontando para esta réplica.
 * (Cliente que ignora o readiness e abre conexões direto na réplica no instante do `close()` ainda pode levar
 * reset: é o tráfego que a drenagem existe para desviar. Ver Módulo 01.)
 */
@Injectable()
export class DrainingConnectionMiddleware implements NestMiddleware {
  constructor(private readonly shutdown: ShutdownState) {}

  use(_req: Request, res: Response, next: NextFunction): void {
    if (this.shutdown.isDraining()) {
      res.setHeader('Connection', 'close');
    }
    next();
  }
}
