import { z } from 'zod';

/**
 * Identidade do usuario final DA APLICACAO DO CLIENTE — quem estava logado quando o erro aconteceu.
 *
 * `email_hash` e prefixo SHA-256 calculado no SDK: e-mail cru nunca trafega. `end_user_tenant` e o
 * tenant DO USUARIO; o `tenant_id` do sistema e outra coisa (a organizacao dona da API key), e por
 * isso o nome e diferente — os dois num mesmo payload seriam indistinguiveis no suporte.
 *
 * Nao confundir com `UserBlockSchema` (event.schema.ts), que e a forma intermediaria do SDK antes da
 * coercao para v4 e ainda aceita e-mail cru.
 */
export const UserSchema = z
  .object({
    id: z.string().min(1).max(256),
    end_user_tenant: z.string().min(1).max(256).optional(),
    email_hash: z.string().min(1).max(128).optional(),
  })
  .strict();

export type UserMetadata = z.infer<typeof UserSchema>;
