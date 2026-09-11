import { z } from "zod";

export const aiToolServersUpdateSchema = z
  .array(
    z
      .object({
        id: z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/u),
        type: z.enum(["openapi", "mcp"]),
        baseUrl: z.string().url().max(2_048),
        specUrl: z.string().url().max(2_048).optional(),
        apiKey: z.string().min(1).max(8_000).optional(),
      })
      .strict(),
  )
  .max(8)
  .optional();
