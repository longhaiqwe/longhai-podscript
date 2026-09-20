import { App, normalizePath, TFile } from "obsidian";
import type { LonghaiPodscriptSettings } from "./settings";
import type { TranscriptFile } from "./runner";

/** 移除 Obsidian / 文件系统不允许的字符，避免创建失败。 */
export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.slice(0, 180) || "播客文字稿";
}

function yamlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** quality 可能是字符串，也可能是 {line_count,total_chars,...} 对象。 */
function formatQuality(q: unknown): string {
	if (!q) return "";
	if (typeof q === "string") return q;
	if (typeof q === "object") {
		const obj = q as Record<string, unknown>;
		const lines = obj.line_count;
		const chars = obj.total_chars;
		if (typeof lines === "number" && typeof chars === "number") {
			return `${lines} 行 / ${chars} 字`;
		}
		try {
			return JSON.stringify(q);
		} catch {
			return "";
		}
	}
	return String(q);
}

function todayISO(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface NoteOverride {
	title?: string;
	podcast?: string;
}

/**
 * 清洗文字稿正文，移除可能导致 Markdown 误渲染的符号：
 * - 移除行首的 > 或 >> （字幕源如 YouTube CC 的换人标记，会被 Markdown 误当成 blockquote 引用格式渲染成竖线框）
 */
export function cleanTranscriptText(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/^>+\s*/, "").trimEnd())
		.join("\n")
		.trim();
}

export function buildNoteContent(
	file: TranscriptFile,
	input: string,
	settings: LonghaiPodscriptSettings,
	override?: NoteOverride,
): { fileName: string; body: string } {
	const meta = file.meta;
	const podcast = (override?.podcast || meta.podcast || meta.podcast_name || "").toString();
	// meta 通常不含 title；CLI 文件名已是「播客名 - 标题」，据此推导标题。
	let title = (override?.title || meta.title || "").toString();
	if (!title) {
		title = file.baseName;
		const prefix = `${podcast} - `;
		if (podcast && title.startsWith(prefix)) {
			title = title.slice(prefix.length);
		}
	}
	const resolver = (meta.resolver || "").toString();
	const quality = formatQuality(meta.quality);
	const source = (meta.source || meta.url || input).toString();

	const front: string[] = ["---"];
	front.push(`title: ${yamlString(title)}`);
	if (podcast) front.push(`podcast: ${yamlString(podcast)}`);
	front.push(`source: ${yamlString(source)}`);
	if (resolver) front.push(`resolver: ${yamlString(resolver)}`);
	if (quality) front.push(`quality: ${yamlString(quality)}`);
	front.push(`asr_model: ${yamlString(settings.asrModel)}`);
	front.push(`fetched: ${todayISO()}`);
	front.push("tags: [播客文字稿]");
	front.push("---");

	const parts: string[] = [front.join("\n"), ""];

	parts.push(cleanTranscriptText(file.content), "");

	// 有覆盖标题（搜索选中的单集）时用「播客名 - 标题」；否则沿用 CLI 规范文件名。
	const fileName = override?.title
		? sanitizeFileName(podcast ? `${podcast} - ${title}` : title)
		: sanitizeFileName(file.baseName);
	return { fileName, body: parts.join("\n") };
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	const normalized = normalizePath(folder);
	if (!normalized || normalized === "/") return;
	if (app.vault.getAbstractFileByPath(normalized)) return;
	try {
		await app.vault.createFolder(normalized);
	} catch {
		// 并发或已存在，忽略。
	}
}

function uniquePath(app: App, folder: string, fileName: string): string {
	const base = folder ? `${normalizePath(folder)}/${fileName}` : fileName;
	let candidate = `${base}.md`;
	let i = 1;
	while (app.vault.getAbstractFileByPath(candidate)) {
		candidate = `${base} (${i}).md`;
		i++;
	}
	return candidate;
}

export async function importTranscripts(
	app: App,
	files: TranscriptFile[],
	inputs: string[],
	settings: LonghaiPodscriptSettings,
	override?: NoteOverride,
): Promise<TFile[]> {
	await ensureFolder(app, settings.outputFolder);
	const created: TFile[] = [];
	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const input = inputs[i] ?? inputs[0] ?? "";
		// 覆盖标题仅适用于单条（搜索选中的单集）。
		const useOverride = files.length === 1 ? override : undefined;
		const { fileName, body } = buildNoteContent(file, input, settings, useOverride);
		const path = uniquePath(app, settings.outputFolder, fileName);
		const tfile = await app.vault.create(path, body);
		created.push(tfile);
	}
	return created;
}
