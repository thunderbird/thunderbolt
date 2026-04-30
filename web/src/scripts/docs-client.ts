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

const renderMermaid = async () => {
	const blocks = document.querySelectorAll('pre[data-language="mermaid"]');
	if (blocks.length === 0) return;
	const { default: mermaid } = await import('mermaid');
	mermaid.initialize({ startOnLoad: false, theme: 'default' });
	blocks.forEach((pre, i) => {
		const src = extractSource(pre);
		const host = document.createElement('div');
		host.className = 'mermaid';
		host.id = 'mermaid-' + i;
		host.textContent = src;
		const wrapper = pre.closest('.expressive-code') ?? pre;
		wrapper.replaceWith(host);
	});
	await mermaid.run({ querySelector: '.mermaid' });
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
