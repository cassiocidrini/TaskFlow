import './env';
import './tracing';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common'; 
import { AppModule } from './app.module';
import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());

  app.enableCors({
  origin: [
      'http://localhost:3001',  // frontend local
      'https://taskflow.app',   // produção
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // remove atributos não declarados no DTO
      forbidNonWhitelisted: true,   // lança erro se vier atributo extra
      transform: true,              // converte tipos automaticamente
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  await app.listen(3000);
  console.log('[App] TaskFlow rodando em http://localhost:3000');
}
bootstrap().catch((err) => {
  console.error('[App] Erro fatal:', err);
  process.exit(1);
});