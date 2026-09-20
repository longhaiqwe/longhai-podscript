import { spawn, ChildProcess } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { AsrModel } from "./settings";
import { ensureBundledScript } from "./script";

export interface TranscriptMeta {
	title?: string;
	podcast?: string;
	podcast_name?: string;
	resolver?: string;
	quality?: string;
	source?: string;
	input?: string;
	url?: string;
	[key: string]: unknown;
}

export interface TranscriptFile {
	txtPath: string;
	baseName: string;
	content: string;
	meta: TranscriptMeta;
}

export interface RunHandle {
	promise: Promise<RunResult>;
	cancel: () => void;
}

export interface RunResult {
	code: number;
	files: TranscriptFile[];
	stderr: string;
	lastLine: string;
}

import { MODELS_DIR } from "./env";

/**
 * 定位转写脚本：优先用用户在设置里显式指定的路径；否则把插件内置脚本释放到本地数据目录并使用。
 * 内置脚本随 main.js 一起分发，因此商店安装也总能拿到，返回值恒为有效路径。
 */
export function resolveScriptPath(configured?: string): string {
	if (configured && configured.trim() && existsSync(configured.trim())) {
		return configured.trim();
	}
	return ensureBundledScript();
}

export interface DoctorResult {
	ok: boolean;
	output: string;
}

export function runDoctor(
	pythonPath: string,
	scriptPath: string,
	envOptions?: { ytdlpPath?: string; modelsDir?: string; binDir?: string },
): Promise<DoctorResult> {
	return new Promise((resolve) => {
		let out = "";
		let child: ChildProcess;
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...(envOptions?.ytdlpPath ? { YT_DLP_PATH: envOptions.ytdlpPath } : {}),
			...(envOptions?.modelsDir ? { PODCAST_ASR_MODEL_ROOT: envOptions.modelsDir } : { PODCAST_ASR_MODEL_ROOT: MODELS_DIR }),
		};
		if (envOptions?.binDir) {
			const sep = process.platform === "win32" ? ";" : ":";
			env.PATH = `${envOptions.binDir}${sep}${process.env.PATH || ""}`;
		}
		try {
			child = spawn(pythonPath, [scriptPath, "--doctor"], { env, windowsHide: true });
		} catch (e) {
			resolve({ ok: false, output: String(e) });
			return;
		}
		child.stdout?.on("data", (d) => (out += d.toString()));
		child.stderr?.on("data", (d) => (out += d.toString()));
		child.on("error", (e) => resolve({ ok: false, output: `${e.message}\n${out}` }));
		child.on("close", (code) => resolve({ ok: code === 0, output: out.trim() }));
	});
}

export interface RunOptions {
	pythonPath: string;
	scriptPath: string;
	inputs: string[];
	outDir: string;
	asrModel: AsrModel;
	podcast?: string;
	ytdlpPath?: string;
	modelsDir?: string;
	binDir?: string;
	onLine?: (line: string) => void;
}

export function runTranscript(opts: RunOptions): RunHandle {
	let child: ChildProcess | null = null;
	let cancelled = false;

	const promise = new Promise<RunResult>((resolve, reject) => {
		const args: string[] = [opts.scriptPath];
		for (const input of opts.inputs) {
			args.push("--input", input);
		}
		args.push("--out-dir", opts.outDir, "--asr-model", opts.asrModel);
		if (opts.podcast && opts.podcast.trim()) {
			args.push("--podcast", opts.podcast.trim());
		}

		const env: NodeJS.ProcessEnv = {
			...process.env,
			...(opts.ytdlpPath ? { YT_DLP_PATH: opts.ytdlpPath } : {}),
			...(opts.modelsDir ? { PODCAST_ASR_MODEL_ROOT: opts.modelsDir } : { PODCAST_ASR_MODEL_ROOT: MODELS_DIR }),
		};
		if (opts.binDir) {
			const sep = process.platform === "win32" ? ";" : ":";
			env.PATH = `${opts.binDir}${sep}${process.env.PATH || ""}`;
		}

		try {
			child = spawn(opts.pythonPath, args, { env, windowsHide: true });
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
			return;
		}

		let stderr = "";
		let stdoutBuffer = "";
		let lastLine = "";

		const handleLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			lastLine = trimmed;

			// 机器协议行（如 OK\t... / META\t...），仅用于程序间读取产物，不向用户日志推送
			if (trimmed.startsWith("OK\t") || trimmed.startsWith("META\t")) {
				return;
			}
			// 步骤流程协议：将 "STEP\t流程说明" 转为面向用户的人话
			if (trimmed.startsWith("STEP\t")) {
				const stepMsg = trimmed.slice(5).trim();
				if (stepMsg) opts.onLine?.(stepMsg);
				return;
			}
			// 模型状态转换
			if (trimmed.startsWith("MODEL_DL\t")) {
				opts.onLine?.("正在下载 Whisper 语音识别模型（首次使用需下载，请稍候）…");
				return;
			}
			if (trimmed.startsWith("MODEL_OK\t")) {
				opts.onLine?.("Whisper 语音模型就绪 ✅");
				return;
			}
			// 失败行友好提示
			if (trimmed.startsWith("FAIL\t")) {
				const parts = trimmed.split("\t");
				const detail = parts[2] || parts[1] || "获取失败";
				opts.onLine?.(`获取未成功：${detail}`);
				return;
			}
			// 过滤包含系统底层临时目录特征的行，杜绝长路径污染面板
			if (trimmed.includes("/private/var/folders/") || trimmed.includes("longhai-podscript-")) {
				return;
			}

			opts.onLine?.(trimmed);
		};

		child.stdout?.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const parts = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = parts.pop() ?? "";
			for (const p of parts) handleLine(p);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
		child.on("close", (code) => {
			if (stdoutBuffer) handleLine(stdoutBuffer);
			if (cancelled) {
				resolve({ code: code ?? -1, files: [], stderr, lastLine: "已取消" });
				return;
			}
			let files: TranscriptFile[] = [];
			try {
				files = collectTranscripts(opts.outDir);
			} catch (e) {
				stderr += `\n读取产物失败: ${String(e)}`;
			}
			resolve({ code: code ?? -1, files, stderr, lastLine });
		});
	});

	return {
		promise,
		cancel: () => {
			cancelled = true;
			child?.kill();
		},
	};
}

function collectTranscripts(outDir: string): TranscriptFile[] {
	if (!existsSync(outDir)) return [];
	const results: TranscriptFile[] = [];
	for (const name of readdirSync(outDir)) {
		if (!name.endsWith(".txt")) continue;
		// 跳过可选的衍生产物，只取主文字稿。
		if (name.endsWith(".body-cleaned.txt") || name.endsWith(".speaker-draft.txt")) continue;
		const txtPath = join(outDir, name);
		const baseName = name.slice(0, -4);
		let content = "";
		try {
			content = readFileSync(txtPath, "utf8");
		} catch {
			continue;
		}
		let meta: TranscriptMeta = {};
		const metaPath = join(outDir, `${baseName}.meta.json`);
		if (existsSync(metaPath)) {
			try {
				meta = JSON.parse(readFileSync(metaPath, "utf8")) as TranscriptMeta;
			} catch {
				meta = {};
			}
		}
		results.push({ txtPath, baseName, content, meta });
	}
	return results;
}
