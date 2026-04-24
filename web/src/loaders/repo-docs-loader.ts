/**
 * Custom content loader that publishes the repository's root-level `/docs/`
 * markdown files through Starlight, so the GitHub-browsable docs and the
 * Starlight site share one source of truth.
 *
 * - Titles are synthesized from each file's H1.
 * - Descriptions are synthesized from the first descriptive paragraph.
 * - Relative `.md` links are rewritten to Starlight routes; relative links
 *   that point outside `/docs/` are rewritten to the GitHub repo.
 */
import type { Loader, LoaderContext } from 'astro/loaders';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Options = {
	/** Path to the docs root, resolved against the Astro config root (e.g. `../docs`). */
	base: string;
	/** URL prefix for generated slugs. Defaults to `docs`. */
	urlPrefix?: string;
	/** Base URL used when rewriting links that point outside the docs directory. */
	githubBaseUrl?: string;
};

const frontmatterRe = /^---\n([\s\S]*?)\n---\n?/;
const h1Re = /^#\s+(.+)$/m;
const stripH1Re = /^#\s+.+\r?\n+/;

export const repoDocsLoader = ({
	base,
	urlPrefix = 'docs',
	githubBaseUrl = 'https://github.com/thunderbird/thunderbolt/blob/main',
}: Options): Loader => ({
	name: 'thunderbolt-repo-docs',
	load: async (context: LoaderContext) => {
		const { store, parseData, generateDigest, renderMarkdown, config } = context;
		const rootPath = fileURLToPath(new URL(base.endsWith('/') ? base : `${base}/`, config.root));
		const astroRootPath = fileURLToPath(config.root);

		store.clear();
		const files = await walkMarkdown(rootPath);
		const knownDocPaths = new Set(files.map((abs) => relative(rootPath, abs).split(sep).join('/')));
		await Promise.all(
			files.map(async (abs) => {
				const raw = await readFile(abs, 'utf8');
				const { data: fm, content } = parseFrontmatter(raw);
				const relPath = relative(rootPath, abs).split(sep).join('/');
				const filePath = relative(astroRootPath, abs).split(sep).join('/');
				const title = fm.title || extractH1(content) || fallbackTitle(relPath);
				const strippedContent = stripH1(content);
				const description = fm.description || extractDescription(strippedContent) || '';
				const slug = computeSlug(relPath, urlPrefix);
				const body = rewriteLinks(strippedContent, relPath, urlPrefix, githubBaseUrl, knownDocPaths);
				const data = await parseData({
					id: slug,
					data: { ...fm, title, description },
				});
				const rendered = await renderMarkdown(body, {
					fileURL: new URL(`file://${abs}`),
				});
				store.set({
					id: slug,
					data,
					body,
					filePath,
					digest: generateDigest(raw),
					rendered,
				});
			}),
		);
	},
});

async function walkMarkdown(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const results = await Promise.all(
		entries
			.filter((e) => !e.name.startsWith('.') && !e.name.startsWith('_'))
			.map((entry) => {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) return walkMarkdown(full);
				if (entry.isFile() && /\.md$/i.test(entry.name)) return Promise.resolve([full]);
				return Promise.resolve([]);
			}),
	);
	return results.flat().sort();
}

export function parseFrontmatter(raw: string) {
	const match = raw.match(frontmatterRe);
	if (!match) return { data: {} as Record<string, string>, content: raw };
	const data: Record<string, string> = {};
	for (const line of match[1].split('\n')) {
		const kv = line.match(/^([\w-]+):\s*(.*)$/);
		if (kv) data[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
	}
	return { data, content: raw.slice(match[0].length) };
}

function extractH1(body: string): string | undefined {
	return body.match(h1Re)?.[1]?.trim();
}

function stripH1(body: string): string {
	return body.replace(stripH1Re, '');
}

/** Pick the first real prose paragraph (skipping code blocks, tables, admonitions, lists). */
export function extractDescription(body: string): string | undefined {
	const blocks = body
		.replace(/^```[\s\S]*?```$/gm, '')
		.split(/\n\s*\n/);
	for (const block of blocks) {
		const trimmed = block.trim();
		if (!trimmed) continue;
		if (/^[#>|\-*+`]/.test(trimmed)) continue;
		if (trimmed.startsWith('<') || trimmed.startsWith('```')) continue;
		const cleaned = trimmed
			.replace(/\s+/g, ' ')
			// Collapse [text](url) → text so raw link syntax never reaches meta tags
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			.replace(/[*_`]/g, '');
		if (cleaned.length < 20) continue;
		return cleaned.length > 200 ? `${cleaned.slice(0, 197)}…` : cleaned;
	}
	return undefined;
}

export function fallbackTitle(relPath: string): string {
	const base = relPath.replace(/\.md$/i, '').split('/').pop() || relPath;
	return base.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function computeSlug(relPath: string, prefix: string): string {
	const withoutExt = relPath.replace(/\.md$/i, '').toLowerCase();
	const parts = withoutExt.split('/');
	const last = parts.at(-1);
	if (last === 'readme' || last === 'index') {
		parts.pop();
		return parts.length === 0 ? prefix : `${prefix}/${parts.join('/')}`;
	}
	return `${prefix}/${withoutExt}`;
}

/** Rewrite relative links so they resolve on the Starlight site. */
export function rewriteLinks(
	body: string,
	sourceRelPath: string,
	urlPrefix: string,
	githubBaseUrl: string,
	knownDocPaths: Set<string>,
): string {
	return body.replace(
		/\[([^\]]+)\]\(([^)\s#]+)(#[^)\s]*)?\)/g,
		(match, text: string, url: string, hash = '') => {
			if (/^([a-z]+:|\/\/|#|mailto:|tel:)/i.test(url) || url.startsWith('/')) return match;
			const repoPath = resolveRepoPath(`docs/${sourceRelPath}`, url);
			if (repoPath.startsWith('docs/')) {
				const docRelPath = repoPath.slice('docs/'.length);
				// Only treat as a docs link if the target file actually exists in docs.
				// Without this check, links like ../src/file.ts from docs/architecture/
				// incorrectly resolve to docs/src/file.ts and generate broken docs URLs.
				const withExt = /\.\w+$/.test(docRelPath) ? docRelPath : `${docRelPath}.md`;
				if (knownDocPaths.has(withExt) || knownDocPaths.has(docRelPath)) {
					const withoutExt = docRelPath.replace(/\.md$/i, '').toLowerCase();
					const parts = withoutExt.split('/');
					const last = parts.at(-1);
					if (last === 'readme' || last === 'index') parts.pop();
					const inner = parts.join('/');
					return `[${text}](/${urlPrefix}${inner ? `/${inner}` : ''}${hash})`;
				}
			}
			return `[${text}](${githubBaseUrl}/${repoPath}${hash})`;
		},
	);
}

/** Resolve a markdown-style relative link to a repo-root-relative path. */
export function resolveRepoPath(fromFile: string, url: string): string {
	const fromDir = fromFile.split('/').slice(0, -1);
	const urlParts = url.split('/').filter((p) => p !== '');
	while (urlParts.length > 0 && (urlParts[0] === '.' || urlParts[0] === '..')) {
		if (urlParts[0] === '..') fromDir.pop();
		urlParts.shift();
	}
	return [...fromDir, ...urlParts].filter(Boolean).join('/');
}
