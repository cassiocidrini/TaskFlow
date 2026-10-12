import { IsString, IsOptional, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateTaskDto {
  @IsString({ message: 'O título deve ser um texto' })
  @MinLength(3, { message: 'O título deve ter ao menos 3 caracteres' })
  @MaxLength(200, { message: 'O título deve ter no máximo 200 caracteres' })
  title!: string;

  @IsOptional()
  @IsUUID('4', { message: 'O assigneeId deve ser um UUID válido' })
  assigneeId?: string;
}