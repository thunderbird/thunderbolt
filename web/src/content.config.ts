/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineCollection, z } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';
import { repoDocsLoader } from './loaders/repo-docs-loader';

export const collections = {
	// Starlight docs collection (thunderbolt.io/docs).
	// Pulls canonical contributor docs straight from the repo-root `/docs/`
	// directory so GitHub and the docs site share one source of truth.
	docs: defineCollection({
		loader: repoDocsLoader({ base: '../docs' }),
		schema: docsSchema(),
	}),

	// Blog collection (thunderbolt.io/blog)
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
