import { z } from "zod";

export const origin = "https://classroom.kindercare.com";

export const journalDateSchema = z.iso.datetime({ offset: true });

export const mediaSchema = z.object({
  id: z.string().regex(/^\d+$/),
  kind: z.enum(["image", "video"]),
  journalDate: journalDateSchema.optional(),
});

export type Media = z.infer<typeof mediaSchema>;

const fileSchema = z.object({
  filename: z
    .string()
    .regex(/^activity-\d+-(image|video)\.(jpg|png|gif|webp|mp4|mov|heic|zip)$/),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  journalDate: journalDateSchema.optional(),
});

export const manifestSchema = z.object({
  version: z.literal(1),
  files: z.record(z.string().regex(/^\d+:(image|video)$/), fileSchema),
});

export type Manifest = z.infer<typeof manifestSchema>;

export class DownloadError extends Error {}

export function mediaKey(media: Media) {
  return `${media.id}:${media.kind}`;
}

export function mediaUrl(media: Media) {
  const parsed = mediaSchema.parse(media);
  return `${origin}/activities/${parsed.id}.${parsed.kind}`;
}

export function journalUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password) {
    throw new DownloadError(
      "Open the photo journal on the KinderCare classroom website.",
    );
  }
  // Persist the page location, never query strings or URL fragments that could hold tokens.
  return `${origin}${url.pathname}`;
}
