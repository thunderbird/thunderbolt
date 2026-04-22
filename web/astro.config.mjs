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
						{ label: 'Overview', slug: 'docs' },
						{ label: 'Introduction', slug: 'docs/introduction' },
						{ label: 'Quick Start', slug: 'docs/quick-start' },
						{ label: 'Development', slug: 'docs/development' },
						{ label: 'Testing', slug: 'docs/testing' },
						{ label: 'Features and Roadmap', slug: 'docs/roadmap' },
						{ label: 'FAQ', slug: 'docs/faq' },
					],
				},
				{
					label: 'Self-Hosting',
					items: [
						{ label: 'Overview', slug: 'docs/self-hosting' },
						{ label: 'Docker Compose', slug: 'docs/docker-compose' },
						{ label: 'Kubernetes', slug: 'docs/kubernetes' },
						{ label: 'Pulumi (AWS)', slug: 'docs/pulumi' },
					],
				},
				{
					label: 'Architecture & Sync',
					items: [
						{ label: 'Architecture', slug: 'docs/architecture' },
						{ label: 'Multi-Device Sync', slug: 'docs/multi-device-sync' },
						{ label: 'End-to-End Encryption', slug: 'docs/e2e-encryption' },
						{
							label: 'PowerSync · Account & Devices',
							slug: 'docs/powersync-account-devices',
						},
						{
							label: 'PowerSync · Sync Middleware',
							slug: 'docs/powersync-sync-middleware',
						},
						{
							label: 'Composite Primary Keys & Default Data',
							slug: 'docs/composite-primary-keys-and-default-data',
						},
						{
							label: 'Delete Account & Revoke Device',
							slug: 'docs/delete-account-and-revoke-device',
						},
					],
				},
				{
					label: 'Platform',
					items: [
						{ label: 'WebView', slug: 'docs/webview' },
						{ label: 'Widget System Guide', slug: 'docs/widgets' },
						{ label: 'Tauri Signing Keys', slug: 'docs/tauri-signing-keys' },
					],
				},
				{
					label: 'Reference',
					items: [{ label: 'Configuration', slug: 'docs/configuration' }],
				},
				{
					label: 'Dev Tooling',
					items: [
						{ label: 'Storybook', slug: 'docs/storybook' },
						{ label: 'Vite Bundle Analyzer', slug: 'docs/vite-bundle-analyzer' },
						{
							label: 'Local CDN for App Updates',
							slug: 'docs/local-cdn-for-app-update-testing',
						},
					],
				},
				{
					label: 'AI & Prompting',
					items: [
						{ label: 'Claude Code Skills', slug: 'docs/claude-code' },
						{
							label: 'GPT-OSS Prompt Engineering',
							slug: 'docs/prompt-engineering-guide/gpt-oss',
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
