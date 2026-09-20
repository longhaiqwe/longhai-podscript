import { FileSystemAdapter, Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_SETTINGS, LonghaiPodscriptSettings, AsrModel, FollowedPodcast } from "./settings";
import type { PodcastResult } from "./search";
import { LonghaiPodscriptSettingTab } from "./settingsTab";
import { resolveScriptPath, runTranscript, RunHandle, RunResult } from "./runner";
import { ensureEnvReady } from "./env";
import { importTranscripts, NoteOverride } from "./note";
import {
	LonghaiPodscriptPanel,
	VIEW_TYPE_LONGHAI_PODSCRIPT,
	TaskState,
	initialTaskState,
} from "./panelView";

const MAX_LOG_LINES = 200;

/** 把脚本回报的 resolver 机器名翻成给人看的人话途径说明，去除任何内部接口或机器参数。 */
export function describeResolver(resolver: unknown): string {
	const r = String(resolver ?? "").trim().toLowerCase();
	if (!r) return "未知途径";
	if (r.includes("scripod")) return "现成字幕 · Scripod";
	if (r.includes("youtube") || r.includes("ytsearch") || r.includes("yt-") || r.includes("subtitle")) {
		if (r.includes("asr")) return "音频本地转写 · Whisper（YouTube 音源）";
		return "现成字幕 · YouTube";
	}
	if (r.includes("official")) return "播客官方文字稿";
	if (r.includes("episode-page-text") || r.includes("page-text")) return "单集网页提取文字稿";
	if (r.includes("asr")) return "音频本地转写 · Whisper";
	return "现成文字稿";
}

export default class LonghaiPodscriptPlugin extends Plugin {
	settings: LonghaiPodscriptSettings = DEFAULT_SETTINGS;
	task: TaskState = initialTaskState();
	private activeRun: RunHandle | null = null;
	/** 上一次获取的参数，用于失败后「重试」。 */
	private lastFetchArgs: {
		inputs: string[];
		asrModel: AsrModel;
		override?: NoteOverride;
		fallback?: string;
	} | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_LONGHAI_PODSCRIPT, (leaf) => new LonghaiPodscriptPanel(leaf, this));

		this.addCommand({
			id: "open-panel",
			name: "获取播客文字稿（打开面板）",
			callback: () => this.activatePanel(),
		});

		this.addCommand({
			id: "cancel-active-fetch",
			name: "取消正在进行的获取",
			checkCallback: (checking) => {
				if (!this.activeRun) return false;
				if (!checking) this.cancelActiveRun();
				return true;
			},
		});

		this.addRibbonIcon("podcast", "Longhai Podscript：打开面板", () => this.activatePanel());

		this.addSettingTab(new LonghaiPodscriptSettingTab(this.app, this));
	}

	onunload(): void {
		this.activeRun?.cancel();
		this.activeRun = null;
	}

	getPluginDir(): string {
		const adapter = this.app.vault.adapter;
		let vaultPath = "";
		if (adapter instanceof FileSystemAdapter) {
			vaultPath = adapter.getBasePath();
		} else if (adapter && "basePath" in adapter) {
			vaultPath = String((adapter as { basePath?: unknown }).basePath || "");
		}
		const manifestDir =
			(this.manifest as unknown as { dir?: string }).dir ||
			join(this.app.vault.configDir, "plugins", this.manifest.id);
		return vaultPath ? join(vaultPath, manifestDir) : "";
	}

	async activatePanel(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_LONGHAI_PODSCRIPT)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: VIEW_TYPE_LONGHAI_PODSCRIPT, active: true });
		}
		if (leaf) {
			workspace.revealLeaf(leaf);
			const view = leaf.view;
			if (view instanceof LonghaiPodscriptPanel) view.focusInput();
		}
	}

	private refreshPanel(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LONGHAI_PODSCRIPT)) {
			const view = leaf.view;
			if (view instanceof LonghaiPodscriptPanel) view.update();
		}
	}

	private log(line: string): void {
		this.task.log.push(line);
		if (this.task.log.length > MAX_LOG_LINES) {
			this.task.log.splice(0, this.task.log.length - MAX_LOG_LINES);
		}
		this.refreshPanel();
	}

	cancelActiveRun(): void {
		if (!this.activeRun) return;
		this.log("正在取消…");
		this.activeRun.cancel();
	}

	/**
	 * 面板「开始获取」/搜索选中单集的入口。
	 * fallback：仅单条获取时使用——主输入（标题）没产出文字稿时，自动改用它（mp3 直链）重试一次。
	 */
	submitFetch(inputs: string[], asrModel: AsrModel, override?: NoteOverride, fallback?: string): void {
		if (!Platform.isDesktopApp) {
			new Notice("「Longhai Podscript」需要桌面端（要调用本地 Python 转写），移动端不支持。");
			return;
		}
		if (this.activeRun) {
			new Notice("已有获取任务在进行，请先等它完成或取消。");
			return;
		}
		// 记住本次参数，失败后「重试」用同样的输入再跑一遍。
		this.lastFetchArgs = { inputs, asrModel, override, fallback };
		void this.runFetch(inputs, asrModel, override, fallback);
	}

	/** 失败后「重试」：用上一次的参数重新获取。 */
	retryLastFetch(): void {
		if (!this.lastFetchArgs) return;
		const { inputs, asrModel, override, fallback } = this.lastFetchArgs;
		this.submitFetch(inputs, asrModel, override, fallback);
	}

	private async runFetch(
		inputs: string[],
		asrModel: AsrModel,
		override?: NoteOverride,
		fallback?: string,
	): Promise<void> {
		const pluginDir = this.getPluginDir();
		const scriptPath = resolveScriptPath(this.settings.scriptPath, pluginDir);
		if (!scriptPath) {
			new Notice(
				"未找到转写脚本 podcast_transcript_txt.py。\n请确保插件文件完整，或在设置中手动指定脚本路径。",
				12000,
			);
			return;
		}

		let outDir: string;
		try {
			outDir = mkdtempSync(join(tmpdir(), "longhai-podscript-"));
		} catch (e) {
			new Notice(`无法创建临时目录：${String(e)}`);
			return;
		}

		this.task = initialTaskState();
		this.task.status = "running";
		this.task.inputs = inputs;
		this.task.startedAt = Date.now();
		await this.activatePanel();
		this.refreshPanel();
		this.log(`已提交 ${inputs.length} 条，正在检查运行环境…`);

		// 检查并准备隔离虚拟环境与依赖（若未创建或缺依赖则自动安装）
		const envReady = await ensureEnvReady({
			configuredPython: this.settings.pythonPath,
			pipIndexUrl: this.settings.pipIndexUrl,
			onLine: (line) => this.log(line),
		});

		if (!envReady.ok || !envReady.venvPython) {
			this.task.status = "error";
			this.task.endedAt = Date.now();
			this.task.errorText = envReady.error || "运行环境未就绪";
			this.log("运行环境未就绪：");
			for (const l of (envReady.error || "").split("\n")) {
				if (l.trim()) this.log(l.trim());
			}
			this.refreshPanel();
			new Notice(`运行环境未就绪：${(envReady.error || "").slice(0, 100)}`, 12000);
			try {
				rmSync(outDir, { recursive: true, force: true });
			} catch {
				// 忽略清理失败
			}
			return;
		}

		this.log("运行环境就绪 ✅");
		this.log("开始获取文字稿…");

		const runOnce = (runInputs: string[]): Promise<RunResult> => {
			const handle = runTranscript({
				pythonPath: envReady.venvPython!,
				scriptPath,
				inputs: runInputs,
				outDir,
				asrModel,
				podcast: override?.podcast,
				ytdlpPath: envReady.ytdlpPath,
				modelsDir: envReady.modelsDir,
				binDir: envReady.binDir,
				onLine: (line) => this.log(line),
			});
			this.activeRun = handle;
			return handle.promise;
		};

		try {
			let usedInputs = inputs;
			let result = await runOnce(inputs);

			// 标题没找到现成字幕（0 产物且未取消）→ 自动退回 mp3 直链本地转写。
			if (result.lastLine !== "已取消" && result.files.length === 0 && fallback) {
				this.log("未检索到现成字幕，自动转为单集音频本地转写…");
				this.log("本地 Whisper 转写约需 10–20 分钟，请以计时器为准…");
				this.task.inputs = [fallback];
				this.refreshPanel();
				usedInputs = [fallback];
				result = await runOnce([fallback]);
			}

			if (result.lastLine === "已取消") {
				this.task.status = "cancelled";
				this.task.endedAt = Date.now();
				this.log("已取消获取。");
				this.refreshPanel();
				new Notice("已取消获取。");
				return;
			}

			if (result.files.length === 0) {
				// lastLine 存的是崩溃时的原始行（可能带 STEP/FAIL 协议前缀），清洗成人话。
				const rawLast = (result.lastLine || "")
					.replace(/^(STEP|FAIL)\t/, "")
					.replace(/\t/g, " ")
					.trim();
				const where = rawLast ? `（中断在：${rawLast.slice(0, 120)}）` : "";
				this.task.status = "error";
				this.task.endedAt = Date.now();
				this.task.canRetry = true;
				this.task.errorText = `没能拿到文字稿${where}。多半是下载或转写中途断了——网络不稳时偶尔会这样，点下面「重试」通常就能成功。`;
				this.log("获取未成功。");
				this.refreshPanel();
				new Notice("没能拿到文字稿，可在右侧面板点「重试」再试一次。", 8000);
				console.error(`[Longhai Podscript] 失败（退出码 ${result.code}）：`, result);
				return;
			}

			for (const f of result.files) {
				this.log(`获取途径：${describeResolver(f.meta.resolver)}`);
			}

			this.log("正在保存为 Obsidian 笔记…");
			const created = await importTranscripts(this.app, result.files, usedInputs, this.settings, override);
			this.task.status = "done";
			this.task.endedAt = Date.now();
			this.task.results = created.map((f) => ({ name: f.basename, path: f.path }));
			this.log(`完成，已生成 ${created.length} 篇文字稿笔记 ✅`);
			this.refreshPanel();
			new Notice(`已生成 ${created.length} 篇文字稿笔记 ✅`);

			if (this.settings.openAfterCreate && created[0] instanceof TFile) {
				await this.app.workspace.getLeaf(true).openFile(created[0]);
			}
			if (result.code !== 0) {
				this.log(`注意：退出码 ${result.code}，部分输入可能失败。`);
				this.refreshPanel();
			}
		} catch (e) {
			this.task.status = "error";
			this.task.endedAt = Date.now();
			this.task.canRetry = true;
			this.task.errorText = `获取出错：${String(e)}`;
			this.log("获取出错。");
			this.refreshPanel();
			new Notice(`获取出错：${String(e)}`, 12000);
			console.error("[Longhai Podscript] 异常：", e);
		} finally {
			this.activeRun = null;
			try {
				rmSync(outDir, { recursive: true, force: true });
			} catch {
				// 忽略清理失败。
			}
		}
	}

	/** 是否已关注某档播客。 */
	isFollowed(collectionId: number): boolean {
		return this.settings.followedPodcasts.some((p) => p.collectionId === collectionId);
	}

	/** 关注 / 取关，返回操作后的关注状态；会持久化并刷新面板。 */
	async toggleFollow(podcast: PodcastResult): Promise<boolean> {
		const idx = this.settings.followedPodcasts.findIndex(
			(p) => p.collectionId === podcast.collectionId,
		);
		let followed: boolean;
		if (idx >= 0) {
			this.settings.followedPodcasts.splice(idx, 1);
			followed = false;
		} else {
			const entry: FollowedPodcast = {
				collectionId: podcast.collectionId,
				name: podcast.name,
				author: podcast.author,
				artwork: podcast.artwork,
				feedUrl: podcast.feedUrl,
			};
			this.settings.followedPodcasts.push(entry);
			followed = true;
		}
		await this.saveSettings();
		this.refreshPanel();
		return followed;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
