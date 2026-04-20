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

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const H1_RE = /^#\s+(.+)$/m;

export const repoDocsLoader = ({
	base,
	urlPrefix = 'docs',
	githubBaseUrl = 'https://github.com/thunderbird/thunderbolt/blob/main',
}: Options): Loader => ({
	name: 'thunderbolt-repo-docs',
	load: async (context: LoaderContext) => {
		const { store, parseData, generateDigest, renderMarkdown, config, watcher, logger } = context;
		const normalizedBase = base.endsWith('/') ? base : `${base}/`;
		const rootPath = fileURLToPath(new URL(normalizedBase, config.root));
		const astroRootPath = fileURLToPath(config.root);

		const rebuild = async () => {
			store.clear();
			const files = await walkMarkdown(rootPath);
			for (const abs of files) {
				const raw = await readFile(abs, 'utf8');
				const { data: fm, content } = parseFrontmatter(raw);
				const relPath = relative(rootPath, abs).split(sep).join('/');
				const filePath = relative(astroRootPath, abs).split(sep).join('/');
				const title = fm.title || extractH1(content) || fallbackTitle(relPath);
				const description = fm.description || extractDescription(content) || '';
				const slug = computeSlug(relPath, urlPrefix);
				const body = rewriteLinks(stripH1(content), relPath, urlPrefix, githubBaseUrl);
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
			}
		};

		await rebuild();

		if (watcher) {
			watcher.add(rootPath);
			const onChange = (file: string) => {
				if (!/\.md$/i.test(file)) return;
				logger.info(`Docs changed (${relative(rootPath, file)}); reloading`);
				rebuild().catch((err) => logger.error(`Docs reload failed: ${err.message}`));
			};
			watcher.on('add', onChange);
			watcher.on('change', onChange);
			watcher.on('unlink', onChange);
		}
	},
});

async function walkMarkdown(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await walkMarkdown(full)));
		} else if (entry.isFile() && /\.md$/i.test(entry.name)) {
			out.push(full);
		}
	}
	return out.sort();
}

function parseFrontmatter(raw: string) {
	const match = raw.match(FRONTMATTER_RE);
	if (!match) return { data: {} as Record<string, string>, content: raw };
	const data: Record<string, string> = {};
	for (const line of match[1].split('\n')) {
		const kv = line.match(/^([\w-]+):\s*(.*)$/);
		if (kv) data[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
	}
	return { data, content: raw.slice(match[0].length) };
}

function extractH1(body: string): string | undefined {
	return body.match(H1_RE)?.[1]?.trim();
}

function stripH1(body: string): string {
	return body.replace(/^#\s+.+\r?\n+/, '');
}

/** Pick the first real prose paragraph (skipping code blocks, tables, admonitions, lists). */
function extractDescription(body: string): string | undefined {
	const blocks = stripH1(body)
		.replace(/^```[\s\S]*?```$/gm, '')
		.split(/\n\s*\n/);
	for (const block of blocks) {
		const trimmed = block.trim();
		if (!trimmed) continue;
		if (/^[#>|\-*+`]/.test(trimmed)) continue;
		if (trimmed.startsWith('<') || trimmed.startsWith('```')) continue;
		const cleaned = trimmed.replace(/\s+/g, ' ').replace(/[*_`]/g, '');
		if (cleaned.length < 20) continue;
		return cleaned.length > 200 ? `${cleaned.slice(0, 197)}…` : cleaned;
	}
	return undefined;
}

function fallbackTitle(relPath: string): string {
	const base = relPath.replace(/\.md$/i, '').split('/').pop() || relPath;
	return base.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function computeSlug(relPath: string, prefix: string): string {
	const withoutExt = relPath.replace(/\.md$/i, '').toLowerCase();
	if (withoutExt === 'readme' || withoutExt === 'index') return prefix;
	return `${prefix}/${withoutExt}`;
}

/** Rewrite relative links so they resolve on the Starlight site. */
function rewriteLinks(
	body: string,
	sourceRelPath: string,
	urlPrefix: string,
	githubBaseUrl: string,
): string {
	return body.replace(
		/\[([^\]]+)\]\(([^)\s#]+)(#[^)\s]*)?\)/g,
		(match, text: string, url: string, hash = '') => {
			if (/^([a-z]+:|\/\/|#|mailto:|tel:)/i.test(url)) return match;
			const repoPath = resolveRepoPath(`docs/${sourceRelPath}`, url);
			if (/\.md$/i.test(repoPath) && repoPath.startsWith('docs/')) {
				const inner = repoPath.slice('docs/'.length).replace(/\.md$/i, '').toLowerCase();
				return `[${text}](/${urlPrefix}/${inner}/${hash})`;
			}
			return `[${text}](${githubBaseUrl}/${repoPath}${hash})`;
		},
	);
}

/** Resolve a markdown-style relative link to a repo-root-relative path. */
function resolveRepoPath(fromFile: string, url: string): string {
	const fromDir = fromFile.split('/').slice(0, -1);
	const urlParts = url.split('/').filter((p) => p !== '');
	while (urlParts.length > 0 && (urlParts[0] === '.' || urlParts[0] === '..')) {
		if (urlParts[0] === '..') fromDir.pop();
		urlParts.shift();
	}
	return [...fromDir, ...urlParts].filter(Boolean).join('/');
}
