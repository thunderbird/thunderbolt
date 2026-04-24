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
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'docs' },
						{ label: 'Features and Roadmap', slug: 'docs/roadmap' },
						{ label: 'FAQ', slug: 'docs/faq' },
					],
				},
				{
					label: 'Self-Hosting',
					items: [
						{ label: 'Overview', slug: 'docs/self-hosting' },
						{ label: 'Configuration', slug: 'docs/self-hosting/configuration' },
						{ label: 'Docker Compose', slug: 'docs/self-hosting/docker-compose' },
						{ label: 'Kubernetes', slug: 'docs/self-hosting/kubernetes' },
						{ label: 'Pulumi (AWS)', slug: 'docs/self-hosting/pulumi' },
					],
				},
				{
					label: 'Features',
					items: [
						{ label: 'Widgets', slug: 'docs/features/widgets' },
						{
							label: 'Data Syncing',
							collapsed: true,
							items: [
								{ label: 'Architecture', slug: 'docs/architecture' },
								{ label: 'Multi-Device Sync', slug: 'docs/architecture/multi-device-sync' },
								{ label: 'End-to-End Encryption', slug: 'docs/architecture/e2e-encryption' },
								{
									label: 'PowerSync · Account & Devices',
									slug: 'docs/architecture/powersync-account-devices',
								},
								{
									label: 'PowerSync · Sync Middleware',
									slug: 'docs/architecture/powersync-sync-middleware',
								},
								{
									label: 'Composite Primary Keys & Default Data',
									slug: 'docs/architecture/composite-primary-keys-and-default-data',
								},
								{
									label: 'Delete Account & Revoke Device',
									slug: 'docs/architecture/delete-account-and-revoke-device',
								},
							],
						},
						{ label: 'WebView', slug: 'docs/features/webview' },
					],
				},
				{
					label: 'Development',
					items: [
						{ label: 'Quick Start', slug: 'docs/development/quick-start' },
						{ label: 'Testing', slug: 'docs/development/testing' },
					],
				},
				{
					label: 'Dev Tooling',
					items: [
						{ label: 'Tauri Signing Keys', slug: 'docs/features/tauri-signing-keys' },
						{ label: 'Storybook', slug: 'docs/dev-tooling/storybook' },
						{ label: 'Vite Bundle Analyzer', slug: 'docs/dev-tooling/vite-bundle-analyzer' },
						{
							label: 'Local CDN for App Updates',
							slug: 'docs/dev-tooling/local-cdn-for-app-update-testing',
						},
					],
				},
			],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
