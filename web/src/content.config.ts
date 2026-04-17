import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';

export const collections = {
	// Starlight docs collection (docs.thunderbolt.io)
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),

	// Blog collection (blog.thunderbolt.io)
	blog: defineCollection({
		loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
		schema: z.object({
			title: z.string(),
			description: z.string(),
			date: z.coerce.date(),
			author: z.string(),
			tags: z.array(z.string()).default([]),
			image: z.string().optional(),
			draft: z.boolean().default(false),
		}),
	}),
};
