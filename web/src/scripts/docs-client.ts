/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const extractSource = (pre: Element): string => {
	const lines = pre.querySelectorAll('.ec-line .code');
	if (lines.length > 0) {
		return Array.from(lines)
			.map((el) => el.textContent)
			.join('\n')
			.trim();
	}
	return (pre as HTMLElement).textContent?.trim() ?? '';
};

const isDark = () => document.documentElement.dataset.theme === 'dark';

/** Mermaid bakes colors into the SVG it generates, so a theme change needs a
 *  re-render rather than a restyle. Keeping each diagram's source on the host
 *  element is what makes that possible after the <pre> has been replaced. */
const renderMermaidDiagrams = async () => {
	const hosts = document.querySelectorAll<HTMLElement>('.mermaid');
	if (hosts.length === 0) return;
	const { default: mermaid } = await import('mermaid');
	// useMaxWidth is Mermaid's default and scales every diagram down to the
	// container. Starlight's prose column is ~750px, so a wide flowchart shrinks
	// until its labels are unreadable. Render at natural size instead and let the
	// host scroll horizontally (see the .mermaid rule in starlight.css).
	mermaid.initialize({
		startOnLoad: false,
		theme: isDark() ? 'dark' : 'default',
		flowchart: { useMaxWidth: false },
		sequence: { useMaxWidth: false },
		gantt: { useMaxWidth: false },
	});
	hosts.forEach((host) => {
		host.removeAttribute('data-processed');
		host.textContent = host.dataset.source ?? host.textContent;
	});
	await mermaid.run({ querySelector: '.mermaid' });
};

const renderMermaid = async () => {
	const blocks = document.querySelectorAll('pre[data-language="mermaid"]');
	if (blocks.length === 0) return;
	blocks.forEach((pre, i) => {
		const src = extractSource(pre);
		const host = document.createElement('div');
		host.className = 'mermaid';
		host.id = 'mermaid-' + i;
		host.dataset.source = src;
		host.textContent = src;
		const wrapper = pre.closest('.expressive-code') ?? pre;
		wrapper.replaceWith(host);
	});
	await renderMermaidDiagrams();

	// Starlight's theme toggle writes data-theme on <html>; re-render so diagram
	// colors follow the page instead of staying on the palette they were built with.
	new MutationObserver(() => {
		void renderMermaidDiagrams();
	}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
};

const addLanguagePills = () => {
	const skip = new Set(['plaintext', 'mermaid', 'txt', '']);
	document
		.querySelectorAll('.expressive-code figure.frame:not(.is-terminal) pre[data-language]')
		.forEach((pre) => {
			const lang = pre.getAttribute('data-language') ?? '';
			if (skip.has(lang)) return;
			const figure = pre.closest('figure');
			if (!figure || figure.querySelector('.lang-pill')) return;
			const pill = document.createElement('span');
			pill.className = 'lang-pill';
			pill.textContent = lang;
			figure.appendChild(pill);
		});
};

const run = async () => {
	addLanguagePills();
	await renderMermaid();
};

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', run);
} else {
	run();
}
