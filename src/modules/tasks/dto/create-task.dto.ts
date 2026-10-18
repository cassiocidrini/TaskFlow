import { IsString, IsOptional, IsUUID, MaxLength, MinLength, IsDateString } from 'class-validator';

export class CreateTaskDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsUUID('4')
  assigneeId?: string;

  @IsOptional()
  @IsDateString() // Valida se é uma data em formato ISO
  dueDate?: string;
}