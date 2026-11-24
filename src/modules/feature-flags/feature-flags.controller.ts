import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AppClient } from '../../common/client/app-client.decorator';
import type { ClientInfo } from '../../common/client/client-info';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FeatureFlagsResponseDto } from './dto/feature-flags.response';
import { FeatureFlags } from './feature-flags';

/**
 * `GET /me/features` (Módulo 14.6): o app chama ao abrir e decide quais telas mostrar.
 *
 * **A regra fica no servidor.** O app recebe só o resultado (`true`/`false`), nunca a porcentagem, a lista de usuários
 * ou as restrições: ninguém descobre quem são os testadores lendo o tráfego, e a regra muda sem versão nova do app
 * (que levaria dias na loja). `/me/...`: sempre o usuário do token, sem id na URL (anti-IDOR por construção).
 *
 * `Cache-Control: private, no-cache`: o resultado é deste usuário (nenhum cache compartilhado o guarda), e o app
 * revalida a cada abertura, para um kill switch chegar rápido.
 */
@ApiTags('features')
@ApiBearerAuth()
@Controller('me/features')
@UseGuards(JwtAuthGuard)
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlags) {}

  @Get()
  @Header('Cache-Control', 'private, no-cache')
  @ApiOperation({
    summary: 'Minhas feature flags',
    description:
      'Todas as flags existentes, avaliadas para o usuário do token e o app dos headers `X-Platform`/`X-App-Version` ' +
      '(restrições de plataforma e versão mínima). Só o resultado: as regras ficam no servidor. Chame ao abrir o app.',
  })
  @ApiResponse({
    status: 200,
    description: 'Mapa flag → ligada/desligada.',
    type: FeatureFlagsResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido.' })
  async mine(
    @CurrentUser() user: AuthenticatedUser,
    @AppClient() client: ClientInfo,
  ): Promise<FeatureFlagsResponseDto> {
    return {
      flags: await this.flags.evaluateAll({ userId: user.userId, client }),
    };
  }
}
