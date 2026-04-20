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
			head: [
				{
					tag: 'script',
					attrs: { type: 'module' },
					content: `
import mermaid from 'https://esm.run/mermaid@11';
const extractSource = (pre) => {
  // Expressive-code wraps each source line in a .ec-line div and drops the
  // trailing newline, so textContent collapses everything onto one line.
  // Reconstruct by joining line elements with \\n.
  const lines = pre.querySelectorAll('.ec-line .code');
  if (lines.length > 0) {
    return Array.from(lines).map((el) => el.textContent).join('\\n').trim();
  }
  return pre.textContent.trim();
};
const renderMermaid = async () => {
  const blocks = document.querySelectorAll('pre[data-language="mermaid"]');
  if (blocks.length === 0) return;
  mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
  blocks.forEach((pre, i) => {
    const src = extractSource(pre);
    const host = document.createElement('div');
    host.className = 'mermaid';
    host.id = 'mermaid-' + i;
    host.textContent = src;
    const wrapper = pre.closest('.expressive-code') || pre;
    wrapper.replaceWith(host);
  });
  await mermaid.run({ querySelector: '.mermaid' });
};
const addLanguagePills = () => {
  const skip = new Set(['plaintext', 'mermaid', 'txt', '']);
  document
    .querySelectorAll('.expressive-code figure.frame:not(.is-terminal) pre[data-language]')
    .forEach((pre) => {
      const lang = pre.getAttribute('data-language') || '';
      if (skip.has(lang)) return;
      const figure = pre.closest('figure');
      if (!figure || figure.querySelector('.lang-pill')) return;
      const pill = document.createElement('span');
      pill.className = 'lang-pill';
      pill.textContent = lang;
      figure.appendChild(pill);
    });
};
const run = () => {
  addLanguagePills();
  renderMermaid();
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', run);
} else {
  run();
}
`,
				},
			],
			logo: {
				src: './src/assets/thunderbolt-logo.png',
				replacesTitle: false,
			},
			favicon: '/favicon.png',
			components: {
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
