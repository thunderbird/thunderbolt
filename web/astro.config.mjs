// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const docsPath = resolve(fileURLToPath(new URL('.', import.meta.url)), '../docs');

/** @type {import('astro').AstroIntegration} */
const docsHmr = {
	name: 'docs-hmr',
	hooks: {
		'astro:server:setup': ({ server, refreshContent }) => {
			if (!refreshContent) return;
			server.watcher.setMaxListeners(server.watcher.getMaxListeners() + 3);
			server.watcher.add(docsPath);
			const refresh = async (/** @type {string} */ file) => {
				if (!file.startsWith(docsPath) || !/\.md$/i.test(file)) return;
				console.log('[docs-hmr] file changed:', file);
				await refreshContent({ loaders: ['thunderbolt-repo-docs'] });
				console.log('[docs-hmr] refreshContent done');

				for (const [envName, env] of Object.entries(server.environments ?? {})) {
					const runner = /** @type {any} */ (env)?.runner;
					const evalMods = runner?.evaluatedModules;
					if (!evalMods) continue;
					let dsId = null;
					for (const [id] of evalMods.idToModuleMap) {
						if (id?.includes('data-store')) { dsId = id; break; }
					}
					if (dsId) {
						console.log(`[docs-hmr] data-store found in runner for env: ${envName}`);
						runner.clearCache();
						console.log(`[docs-hmr] cleared runner cache for env: ${envName}`);
					} else {
						console.log(`[docs-hmr] data-store NOT in runner for env: ${envName} (size: ${evalMods.idToModuleMap.size})`);
					}
				}
			};
			server.watcher.on('change', refresh);
			server.watcher.on('add', refresh);
			server.watcher.on('unlink', refresh);
		},
	},
};

// https://astro.build/config
export default defineConfig({
	site: 'https://thunderbolt.io',
	redirects: {
		'/announcing-thunderbolt': '/blog/mozilla-introduces-thunderbolt',
	},
	integrations: [
		docsHmr,
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
					label: 'Development',
					items: [
						{ label: 'Quick Start', slug: 'docs/development/quick-start' },
						{ label: 'Testing', slug: 'docs/development/testing' },
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
					label: 'Data Syncing',
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
				{
					label: 'Platform',
					items: [
						{ label: 'WebView', slug: 'docs/platform/webview' },
						{ label: 'Widgets', slug: 'docs/platform/widgets' },
					],
				},
				{
					label: 'Dev Tooling',
					items: [
						{ label: 'Tauri Signing Keys', slug: 'docs/platform/tauri-signing-keys' },
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
