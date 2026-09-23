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
		'/docs/quick-start': '/docs/development/quick-start',
		'/docs/multi-device-sync': '/docs/architecture/multi-device-sync',
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
						{ label: 'How do I...?', slug: 'docs/how-do-i' },
						{ label: 'Customize', slug: 'docs/customize' },
						{ label: 'FAQ', slug: 'docs/faq' },
					],
				},
				{
					label: 'Using Thunderbolt',
					items: [
						{ label: 'Projects', slug: 'docs/architecture/projects' },
						{ label: 'Skills', slug: 'docs/architecture/skills' },
						{ label: 'Widgets', slug: 'docs/features/widgets' },
						{ label: 'HTML Artifacts', slug: 'docs/architecture/artifacts' },
						{ label: 'Chat Attachments', slug: 'docs/architecture/attachments' },
						{ label: 'Search & Command Palette', slug: 'docs/architecture/search' },
						{ label: 'Voice Mode', slug: 'docs/architecture/voice' },
						{ label: 'Content View', slug: 'docs/architecture/content-view' },
						{ label: 'WebView', slug: 'docs/features/webview' },
						{ label: 'MCP Connections', slug: 'docs/architecture/mcp-connections' },
						{ label: 'ACP Agents', slug: 'docs/architecture/acp-agents' },
						{ label: 'Multi-Device Sync', slug: 'docs/architecture/multi-device-sync' },
						{ label: 'End-to-End Encryption', slug: 'docs/architecture/e2e-encryption' },
						{ label: 'Data Export Format', slug: 'docs/architecture/export-format' },
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
						{ label: 'iroh Relay', slug: 'docs/architecture/iroh-relay-self-hosting' },
					],
				},
				{
					label: 'Developing',
					items: [
						{ label: 'Quick Start', slug: 'docs/development/quick-start' },
						{ label: 'Frontend Structure', slug: 'docs/development/frontend-structure' },
						{ label: 'The shared/ Module', slug: 'docs/architecture/shared-module' },
						{ label: 'Error Handling', slug: 'docs/development/error-handling' },
						{ label: 'Testing', slug: 'docs/development/testing' },
						{ label: 'Integrations', slug: 'docs/development/integrations' },
						{ label: 'Mobile Setup', slug: 'docs/development/mobile-setup' },
						{ label: 'CI & Preview Environments', slug: 'docs/development/ci-and-previews' },
						{
							label: 'Tooling',
							collapsed: true,
							items: [
								{ label: 'AI Code Review', slug: 'docs/dev-tooling/ai-code-review' },
								{ label: 'Storybook', slug: 'docs/dev-tooling/storybook' },
								{ label: 'Vite Bundle Analyzer', slug: 'docs/dev-tooling/vite-bundle-analyzer' },
								{ label: 'Local CDN for App Updates', slug: 'docs/dev-tooling/local-cdn-for-app-update-testing' },
								{ label: 'Tauri Signing Keys', slug: 'docs/features/tauri-signing-keys' },
							],
						},
					],
				},
				{
					label: 'Architecture',
					collapsed: true,
					items: [
						{ label: 'Overview', slug: 'docs/architecture' },
						{
							label: 'Client runtime',
							collapsed: true,
							items: [
								{ label: 'App Initialization', slug: 'docs/architecture/app-initialization' },
								{ label: 'Chat Runtime', slug: 'docs/architecture/chat-runtime' },
								{ label: 'System Prompt, Tools & Citations', slug: 'docs/architecture/prompt-and-tools' },
								{ label: 'In-Browser Agent Harness', slug: 'docs/architecture/in-browser-agent-harness' },
								{ label: 'Client Auth & Session', slug: 'docs/architecture/client-auth-and-session' },
								{ label: 'Settings & Preferences', slug: 'docs/architecture/settings-and-preferences' },
								{ label: 'Debug Transcripts', slug: 'docs/architecture/debug-transcripts' },
							],
						},
						{
							label: 'Data & sync',
							collapsed: true,
							items: [
								{ label: 'Data Access Layer', slug: 'docs/architecture/data-access-layer' },
								{ label: 'Reconciled Defaults', slug: 'docs/architecture/reconciled-defaults' },
								{ label: 'Client Data Migrations', slug: 'docs/architecture/client-data-migrations' },
								{ label: 'PowerSync · Account & Devices', slug: 'docs/architecture/powersync-account-devices' },
								{ label: 'PowerSync · Sync Middleware', slug: 'docs/architecture/powersync-sync-middleware' },
								{ label: 'PowerSync · Upload Authorization', slug: 'docs/architecture/powersync-upload-authorization' },
								{ label: 'Composite Primary Keys & Default Data', slug: 'docs/architecture/composite-primary-keys-and-default-data' },
								{ label: 'Delete Account & Revoke Device', slug: 'docs/architecture/delete-account-and-revoke-device' },
							],
						},
						{
							label: 'Backend & inference',
							collapsed: true,
							items: [
								{ label: 'Backend API Surface', slug: 'docs/architecture/backend-api-surface' },
								{ label: 'Universal Proxy', slug: 'docs/architecture/universal-proxy' },
								{ label: 'Managed Inference', slug: 'docs/architecture/managed-inference' },
								{ label: 'Sign-in & Waitlist', slug: 'docs/architecture/sign-in-and-waitlist' },
							],
						},
						{
							label: 'Native shell',
							collapsed: true,
							items: [{ label: 'Tauri Shell', slug: 'docs/architecture/tauri-shell' }],
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
