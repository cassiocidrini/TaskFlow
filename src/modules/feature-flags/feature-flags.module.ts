import { Module } from '@nestjs/common';
import { FeatureFlags } from './feature-flags';
import { FeatureFlagsController } from './feature-flags.controller';
import { PostgresFeatureFlags } from './postgres-feature-flags';

/**
 * Feature flags (Módulo 14.6). Exporta a PORTA `FeatureFlags`: quem usa uma flag (14.7) injeta a porta, nunca o adapter.
 */
@Module({
  controllers: [FeatureFlagsController],
  providers: [{ provide: FeatureFlags, useClass: PostgresFeatureFlags }],
  exports: [FeatureFlags],
})
export class FeatureFlagsModule {}
