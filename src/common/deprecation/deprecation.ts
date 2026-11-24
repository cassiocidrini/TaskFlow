import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Response } from 'express';
import { appVersionLabel, type ClientInfo } from '../client/client-info';

/** Um campo da API em depreciação: desde quando, até quando, e onde ler o porquê. */
export interface DeprecatedField {
  name: string;
  /** Quando foi depreciado (o valor do header `Deprecation`). */
  deprecatedAt: Date;
  /** A partir de quando pode deixar de existir (header `Sunset`). Uma intenção publicada, não uma remoção automática. */
  sunsetAt: Date;
  /** Documentação da migração (header `Link` com `rel="deprecation"`). */
  link: string;
}

/** Headers que o JavaScript de outra origem precisa conseguir LER (entram no `exposedHeaders` do CORS). */
export const DEPRECATION_HEADERS = ['Deprecation', 'Sunset', 'Link'] as const;

/** Módulo 14.4: `dueDate` → `due { at, timezone }`. */
export const DUE_DATE_DEPRECATION: DeprecatedField = Object.freeze({
  name: 'dueDate',
  deprecatedAt: new Date('2026-11-24T00:00:00Z'),
  sunsetAt: new Date('2027-03-01T00:00:00Z'),
  link: 'https://github.com/cassiocidrini/TaskFlow/blob/main/docs/modules/14-api-para-web-e-apps.md',
});

/**
 * Avisa e mede o uso de um campo depreciado (Módulo 14.4). Chamado pelo handler SÓ quando a requisição usou o campo
 * antigo: os headers chegam a quem precisa migrar, e a métrica diz QUEM ainda não migrou.
 *
 * - **`Deprecation: @<epoch>`** (RFC 9745) e **`Sunset: <HTTP-date>`** (RFC 8594), mais `Link` com
 *   `rel="deprecation"`: o desenvolvedor do app vê no log de rede, e ferramentas de cliente sabem ler.
 * - **`taskflow_deprecated_field_usage_total{field, platform, app_version}`**: a decisão de quando REMOVER o campo
 *   sai daqui ("a última versão que manda `dueDate` é a 2.13: mínima em 2.14, e então o contract"). Mesma
 *   cardinalidade limitada da 14.1 (`MAJOR.MINOR`).
 *
 * Limite honesto: dá para medir quem ENVIA o campo antigo, não quem o LÊ nas respostas. Por isso o critério final do
 * contract é a versão mínima (14.2), e não só esta métrica.
 */
@Injectable()
export class DeprecationNotifier {
  private readonly usage = metrics
    .getMeter('taskflow-api')
    .createCounter('taskflow_deprecated_field_usage', {
      description:
        'Requisições que usaram um campo depreciado, por campo, plataforma e versão do app (MAJOR.MINOR)',
    });

  fieldUsed(res: Response, field: DeprecatedField, client: ClientInfo): void {
    res.setHeader(
      'Deprecation',
      `@${Math.floor(field.deprecatedAt.getTime() / 1000)}`,
    );
    res.setHeader('Sunset', field.sunsetAt.toUTCString());
    res.setHeader('Link', `<${field.link}>; rel="deprecation"; type="text/html"`);
    this.usage.add(1, {
      field: field.name,
      platform: client.platform,
      app_version: appVersionLabel(client),
    });
  }
}
