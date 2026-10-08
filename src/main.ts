import './env';        // ← carrega o .env ANTES de tudo
import './tracing';    // ← depois inicializa o OTel
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
  console.log('[App] TaskFlow rodando em http://localhost:3000');
}

bootstrap().catch((err) => {
  console.error('[App] Erro fatal ao iniciar:', err);
  process.exit(1);
});