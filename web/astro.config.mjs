/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

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
			],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
