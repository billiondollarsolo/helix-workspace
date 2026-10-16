import { z } from "zod";

export const PASSWORD_VAULT_MAX_BYTES = 1_048_576;
export const passwordVaultWriteSchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    ciphertext: z
      .string()
      .min(16)
      .max(Math.ceil(PASSWORD_VAULT_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
      .refine((value) => value.length % 4 === 0),
  })
  .strict();
export const passwordVaultSchema = z.object({
  version: z.number().int().positive(),
  ciphertext: passwordVaultWriteSchema.shape.ciphertext,
  updatedAt: z.string().datetime(),
});
export const passwordVaultResponseSchema = z.object({
  vault: passwordVaultSchema.nullable(),
  previous: passwordVaultSchema.nullable(),
});
export type PasswordVault = z.infer<typeof passwordVaultSchema>;
export type PasswordVaultResponse = z.infer<typeof passwordVaultResponseSchema>;
