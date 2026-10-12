import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { AuthModule } from './modules/auth/auth.module';

// Em testes, não registra o throttle (evita 429 nos E2E)
const throttleDisabled = process.env.DISABLE_THROTTLE === 'true';

@Module({
  imports: [
    PrismaModule,
    CqrsModule.forRoot(),
    TasksModule,
    AuthModule,
    ...(throttleDisabled
      ? []
      : [
          ThrottlerModule.forRoot([
            { ttl: 60_000, limit: 100 },
          ]),
        ]),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    ...(throttleDisabled
      ? []
      : [{ provide: APP_GUARD, useClass: ThrottlerGuard }]),
  ],
})
export class AppModule {}