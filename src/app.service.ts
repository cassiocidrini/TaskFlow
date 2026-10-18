import { Injectable } from '@nestjs/common';

/** Serviço do scaffold, usado só pela rota raiz (ver {@link AppController}). */
@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }
}
