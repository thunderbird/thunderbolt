/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
//
// Mirrors the Vite/Tailwind/React setup from thunderbolt's `web/` project, but
// scoped to just this standalone site. The imported design (public/index.html +
// support.js) is fully self-contained and boots its own React runtime client
// side, so Astro's role here is dev server + static build (output -> ./dist).
export default defineConfig({
	site: 'https://thunderbolt.io',
	integrations: [react()],
	vite: {
		plugins: [tailwindcss()],
	},
});
