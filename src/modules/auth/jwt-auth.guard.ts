import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Guard de autenticação: exige um JWT válido, delegando a validação ao {@link JwtStrategy}.
 *
 * Aplicado no nível da CLASSE nos controllers de domínio (`ProjectsController`, `TasksController`):
 * *secure by default* — uma rota nova nasce protegida, em vez de depender de alguém lembrar de anotá-la.
 * Foi exatamente a ausência deste guard que deixou as rotas de tarefas abertas antes da correção (OWASP A01).
 *
 * Autenticação responde "quem é você?". A AUTORIZAÇÃO ("você pode mexer NESTE recurso?") fica no
 * `ProjectsService.assertOwner`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
