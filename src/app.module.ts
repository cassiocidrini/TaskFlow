import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv, type Env } from './config/env.schema';
import { PrismaModule } from './prisma/prisma.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [
    // Primeiro import: valida o ambiente antes de qualquer outro módulo usar config
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    PrismaModule,
    CqrsModule.forRoot(),
    TasksModule,
    AuthModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        // Em testes (DISABLE_THROTTLE=true) o guard continua registrado, mas não bloqueia
        skipIf: () => config.get('DISABLE_THROTTLE', { infer: true }),
      }),
    }),
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
