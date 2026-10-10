import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CqrsModule } from '@nestjs/cqrs';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [
    PrismaModule,
    CqrsModule.forRoot(),
    TasksModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
