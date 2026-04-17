// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
	site: 'https://thunderbolt.io',
	integrations: [
		react(),
		starlight({
			title: 'Thunderbolt Docs',
			customCss: ['./src/styles/starlight.css'],
			logo: {
				src: './src/assets/thunderbolt-logo.png',
				replacesTitle: false,
			},
			favicon: '/favicon.png',
			components: {
				ThemeSelect: './src/components/starlight/ThemeSelect.astro',
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/thunderbird/thunderbolt',
				},
			],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'docs/getting-started/introduction' },
						{ label: 'Quick Start', slug: 'docs/getting-started/quick-start' },
					],
				},
				{
					label: 'Self-Hosting',
					items: [
						{ label: 'Overview', slug: 'docs/guides/self-hosting' },
						{ label: 'Docker Compose', slug: 'docs/guides/docker-compose' },
						{ label: 'Kubernetes', slug: 'docs/guides/kubernetes' },
						{ label: 'Pulumi (AWS)', slug: 'docs/guides/pulumi' },
					],
				},
				{
					label: 'Features',
					items: [
						{ label: 'Multi-Device Sync', slug: 'docs/guides/multi-device-sync' },
						{ label: 'Account & Devices', slug: 'docs/guides/account-and-devices' },
						{ label: 'End-to-End Encryption', slug: 'docs/guides/end-to-end-encryption' },
					],
				},
				{
					label: 'Contributing',
					items: [{ label: 'Development & Testing', slug: 'docs/guides/contributing' }],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Configuration', slug: 'docs/reference/configuration' },
						{ label: 'Architecture', slug: 'docs/reference/architecture' },
					],
				},
			],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
