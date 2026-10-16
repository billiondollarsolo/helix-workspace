import { z } from "zod";

export const vaultDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Enter an item name.").max(500),
  username: z.string().max(1000),
  password: z.string().max(1000),
  website: z
    .string()
    .max(2000)
    .refine((value) => value === "" || /^https?:\/\//iu.test(value), "Use https:// or http://."),
  notes: z.string().max(10000),
});
export type VaultDraft = z.infer<typeof vaultDraftSchema>;
export interface VaultListItem {
  readonly id: string;
  readonly name: string;
  readonly username: string;
}
