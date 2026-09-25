/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

const repoBlobUrl = 'https://github.com/thunderbird/thunderbolt/blob/main';
const repoTreeUrl = 'https://github.com/thunderbird/thunderbolt/tree/main';

// https://astro.build/config
export default defineConfig({
	site: 'https://thunderbolt.io',
	redirects: {
		'/announcing-thunderbolt': '/blog/mozilla-introduces-thunderbolt',
		// Old root-level self-hosting docs were duplicates of /docs/self-hosting/*.
		// Removed to eliminate drift; redirect old URLs to the canonical ones.
		'/docs/configuration': '/docs/self-hosting/configuration',
		'/docs/kubernetes': '/docs/self-hosting/kubernetes',
		'/docs/docker-compose': '/docs/self-hosting/docker-compose',
		'/docs/pulumi': '/docs/self-hosting/pulumi',
		// Old root-level docs duplicated by maintained pages elsewhere in /docs/.
		'/docs/introduction': '/docs',
		'/docs/quick-start': '/docs/self-hosting/docker-compose',
		'/docs/multi-device-sync': '/docs/using/apps-and-sync',
		// Contributor docs moved under docs/internals/, which repo-docs-loader.ts
		// does not publish. This map covers exactly the pages `main` published
		// before the move, derived from `git ls-tree main docs` rather than from
		// the current tree: most files under docs/internals/ are new on this
		// branch and never had a public URL, so they need no entry.
		// Where the topic has a public successor, point there.
		'/docs/architecture/projects': '/docs/using/projects',
		'/docs/architecture/multi-device-sync': '/docs/using/apps-and-sync',
		'/docs/architecture/powersync-sync-middleware': '/docs/using/apps-and-sync',
		'/docs/architecture/e2e-encryption': '/docs/admin/security-and-privacy',
		'/docs/architecture/delete-account-and-revoke-device': '/docs/admin/devices',
		'/docs/architecture/powersync-account-devices': '/docs/admin/devices',
		'/docs/development/quick-start': '/docs/self-hosting/docker-compose',
		// The rest have no public counterpart, so they go to the source file on
		// GitHub — where repo-docs-loader.ts already sends in-page links to
		// anything outside the published tree.
		'/docs/architecture': `${repoTreeUrl}/docs/internals/architecture`,
		'/docs/architecture/composite-primary-keys-and-default-data': `${repoBlobUrl}/docs/internals/architecture/composite-primary-keys-and-default-data.md`,
		'/docs/architecture/export-format': `${repoBlobUrl}/docs/internals/architecture/export-format.md`,
		'/docs/architecture/iroh-relay-self-hosting': `${repoBlobUrl}/docs/internals/architecture/iroh-relay-self-hosting.md`,
		'/docs/development/mobile-setup': `${repoBlobUrl}/docs/internals/development/mobile-setup.md`,
		'/docs/development/testing': `${repoBlobUrl}/docs/internals/development/testing.md`,
		'/docs/dev-tooling/storybook': `${repoBlobUrl}/docs/internals/dev-tooling/storybook.md`,
		'/docs/dev-tooling/vite-bundle-analyzer': `${repoBlobUrl}/docs/internals/dev-tooling/vite-bundle-analyzer.md`,
		'/docs/dev-tooling/local-cdn-for-app-update-testing': `${repoBlobUrl}/docs/internals/dev-tooling/local-cdn-for-app-update-testing.md`,
		'/docs/features/tauri-signing-keys': `${repoBlobUrl}/docs/internals/tauri-signing-keys.md`,
		'/docs/features/widgets': `${repoBlobUrl}/docs/internals/widgets.md`,
	},
	integrations: [
		react(),
		starlight({
			title: 'Thunderbolt Docs',
			customCss: ['./src/styles/starlight.css'],
			expressiveCode: {
				themes: ['night-owl'],
				useStarlightUiThemeColors: false,
				styleOverrides: {
					borderRadius: '0',
					codeBackground: '#0f172a',
					codeFontFamily: 'var(--tb-font-mono)',
					frames: {
						frameBoxShadowCssValue: 'none',
					},
				},
			},
			logo: {
				src: './src/assets/thunderbolt-logo.png',
				replacesTitle: false,
			},
			favicon: '/favicon.png',
			components: {
				Head: './src/components/starlight/Head.astro',
				Header: './src/components/starlight/Header.astro',
				ThemeSelect: './src/components/starlight/ThemeSelect.astro',
			},
			sidebar: [
				{
					label: 'Start Here',
					items: [
						{ label: 'What is Thunderbolt?', slug: 'docs' },
						{ label: 'FAQ', slug: 'docs/faq' },
						{ label: 'Troubleshooting', slug: 'docs/troubleshooting' },
					],
				},
				{
					label: 'Using Thunderbolt',
					items: [
						{ label: 'Overview', slug: 'docs/using' },
						{ label: 'Chat', slug: 'docs/using/chat' },
						{ label: 'Projects', slug: 'docs/using/projects' },
						{ label: 'Skills', slug: 'docs/using/skills' },
						{ label: 'Connections', slug: 'docs/using/connections' },
						{ label: 'Search', slug: 'docs/using/search' },
						{ label: 'Voice', slug: 'docs/using/voice' },
						{ label: 'Apps and sync', slug: 'docs/using/apps-and-sync' },
						{ label: 'In-app browser', slug: 'docs/features/webview' },
						{ label: 'Customize', slug: 'docs/customize' },
					],
				},
				{
					label: 'Deploy',
					items: [
						{ label: 'Choosing a deployment', slug: 'docs/self-hosting' },
						{ label: 'Requirements', slug: 'docs/self-hosting/requirements' },
						{ label: 'Docker Compose', slug: 'docs/self-hosting/docker-compose' },
						{ label: 'Kubernetes', slug: 'docs/self-hosting/kubernetes' },
						{ label: 'AWS with Pulumi', slug: 'docs/self-hosting/pulumi' },
						{ label: 'Upgrading', slug: 'docs/self-hosting/upgrading' },
						{ label: 'Backup and restore', slug: 'docs/self-hosting/backup-and-restore' },
						{ label: 'Monitoring', slug: 'docs/self-hosting/monitoring' },
					],
				},
				{
					label: 'Configure',
					items: [
						{ label: 'Settings reference', slug: 'docs/self-hosting/configuration' },
						{ label: 'Authentication', slug: 'docs/self-hosting/authentication' },
						{ label: 'Models and inference', slug: 'docs/self-hosting/models' },
					],
				},
				{
					label: 'Administer',
					items: [
						{ label: 'Users and access', slug: 'docs/admin/users-and-access' },
						{ label: 'Devices and accounts', slug: 'docs/admin/devices' },
						{ label: 'Security and privacy', slug: 'docs/admin/security-and-privacy' },
					],
				},
			],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
