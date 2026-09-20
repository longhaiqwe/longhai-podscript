import { ItemView, WorkspaceLeaf, TFile, setIcon } from "obsidian";
import type LonghaiPodscriptPlugin from "./main";
import {
	searchPodcasts,
	searchEpisodes,
	lookupEpisodes,
	PodcastResult,
	EpisodeResult,
} from "./search";

export const VIEW_TYPE_LONGHAI_PODSCRIPT = "longhai-podscript-panel";

export type TaskStatus = "idle" | "running" | "done" | "error" | "cancelled";

export interface ResultLink {
	name: string;
	path: string;
}

export interface TaskState {
	status: TaskStatus;
	inputs: string[];
	startedAt: number | null;
	endedAt: number | null;
	log: string[];
	results: ResultLink[];
	errorText: string;
	/** 失败可重试（下载/转写等偶发中断），面板据此显示「重试」按钮。 */
	canRetry: boolean;
}

export function initialTaskState(): TaskState {
	return {
		status: "idle",
		inputs: [],
		startedAt: null,
		endedAt: null,
		log: [],
		results: [],
		errorText: "",
		canRetry: false,
	};
}

const STATUS_TEXT: Record<TaskStatus, string> = {
	idle: "空闲",
	running: "获取中",
	done: "已完成",
	error: "获取失败",
	cancelled: "已取消",
};

type Tab = "all" | "podcasts" | "episodes";

export class LonghaiPodscriptPanel extends ItemView {
	private readonly plugin: LonghaiPodscriptPlugin;

	private manualValue = "";

	// 搜索状态
	private tab: Tab = "all";
	private searching = false;
	private searchError = "";
	private podcasts: PodcastResult[] = [];
	private episodes: EpisodeResult[] = [];
	private drillPodcast: PodcastResult | null = null;
	private drillEpisodes: EpisodeResult[] | null = null;
	private detailEpisode: EpisodeResult | null = null;

	// 元素引用
	private searchInput!: HTMLInputElement;
	private searchClearBtn!: HTMLElement;
	private tabsEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private manualArea!: HTMLTextAreaElement;
	private taskCardEl!: HTMLElement;
	private statusDotEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private elapsedEl!: HTMLElement;
	private cancelBtn!: HTMLButtonElement;
	private progressEl!: HTMLElement;
	private liveLineEl!: HTMLElement;
	private taskInputEl!: HTMLElement;
	private logDetailsEl!: HTMLDetailsElement;
	private logSummaryEl!: HTMLElement;
	private logEl!: HTMLElement;
	private taskResultEl!: HTMLElement;
	private startBtn!: HTMLButtonElement;
	private renderedLog = 0;
	private built = false;

	constructor(leaf: WorkspaceLeaf, plugin: LonghaiPodscriptPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_LONGHAI_PODSCRIPT;
	}
	getDisplayText(): string {
		return "Longhai Podscript";
	}
	getIcon(): string {
		return "podcast";
	}

	onOpen(): Promise<void> {
		this.build();
		this.update();
		this.registerInterval(
			window.setInterval(() => {
				if (this.plugin.task.status === "running") this.updateElapsed();
			}, 1000),
		);
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.contentEl.empty();
		this.built = false;
		return Promise.resolve();
	}

	focusInput(): void {
		this.searchInput?.focus();
	}

	private build(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("longhai-podscript-panel");

		// —— 固定顶部区（品牌 + 搜索 + 分类标签，始终可见，不随内容滚动）——
		const top = root.createDiv({ cls: "sp-top" });

		// —— 头部 ——
		const header = top.createDiv({ cls: "sp-header" });
		const brand = header.createDiv({ cls: "sp-brand" });
		setIcon(brand.createSpan({ cls: "sp-brand-icon" }), "podcast");
		brand.createSpan({ text: "Longhai Podscript", cls: "sp-brand-name" });
		header.createDiv({ text: "搜索播客 → 获取文字稿 → 保存到笔记", cls: "sp-brand-sub" });

		// —— 搜索 ——
		const searchBox = top.createDiv({ cls: "sp-search" });
		setIcon(searchBox.createSpan({ cls: "sp-search-icon" }), "search");
		this.searchInput = searchBox.createEl("input", {
			cls: "sp-search-input",
			attr: { type: "text", placeholder: "搜索播客或单集…", enterkeyhint: "search" },
		});
		this.searchInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void this.doSearch();
			}
		});
		this.searchInput.addEventListener("input", () => this.syncSearchClear());
		this.searchClearBtn = searchBox.createSpan({ cls: "sp-search-clear sp-hidden" });
		this.searchClearBtn.setAttr("aria-label", "清空");
		setIcon(this.searchClearBtn, "x");
		this.searchClearBtn.onclick = () => {
			this.searchInput.value = "";
			this.syncSearchClear();
			this.podcasts = [];
			this.episodes = [];
			this.drillPodcast = null;
			this.drillEpisodes = null;
			this.detailEpisode = null;
			this.searchError = "";
			this.renderResults();
			this.searchInput.focus();
		};

		// 分类标签（搜索出结果后才显示）
		this.tabsEl = top.createDiv({ cls: "sp-tabs sp-hidden" });

		// —— 中间唯一的纵向滚动区 ——
		this.resultsEl = root.createDiv({ cls: "sp-search-results" });

		// —— 固定底部区（手动获取 + 任务卡片，常驻底部）——
		const footer = root.createDiv({ cls: "sp-footer" });

		// —— 手动输入（折叠）——
		const details = footer.createEl("details", { cls: "sp-manual" });
		const summary = details.createEl("summary", { cls: "sp-manual-summary" });
		setIcon(summary.createSpan({ cls: "sp-manual-caret" }), "chevron-right");
		summary.createSpan({ text: "粘贴链接 / 标题手动获取" });
		this.manualArea = details.createEl("textarea", { cls: "sp-textarea" });
		this.manualArea.rows = 3;
		this.manualArea.placeholder = "https://www.youtube.com/watch?v=...\n每行一个链接或标题";
		this.manualArea.value = this.manualValue;
		this.manualArea.addEventListener("input", () => (this.manualValue = this.manualArea.value));
		const manualBtn = details.createEl("button", { text: "开始获取", cls: "mod-cta sp-start" });
		manualBtn.onclick = () => this.submitManual();

		// —— 任务卡片（状态驱动，空闲隐藏）——
		const card = footer.createDiv({ cls: "sp-task-card sp-hidden" });
		this.taskCardEl = card;

		const head = card.createDiv({ cls: "sp-task-head" });
		this.statusDotEl = head.createSpan({ cls: "sp-status-dot" });
		this.statusEl = head.createSpan({ cls: "sp-status-text" });
		this.elapsedEl = head.createSpan({ cls: "sp-elapsed" });
		this.cancelBtn = head.createEl("button", { text: "取消", cls: "sp-cancel" });
		this.cancelBtn.onclick = () => this.plugin.cancelActiveRun();

		this.progressEl = card.createDiv({ cls: "sp-progress sp-hidden" });
		this.progressEl.createDiv({ cls: "sp-progress-bar" });

		this.liveLineEl = card.createDiv({ cls: "sp-live-line sp-hidden" });
		this.taskInputEl = card.createDiv({ cls: "sp-inputs" });

		this.logDetailsEl = card.createEl("details", { cls: "sp-log-details" });
		this.logSummaryEl = this.logDetailsEl.createEl("summary", { cls: "sp-log-summary", text: "运行日志" });
		this.logEl = this.logDetailsEl.createDiv({ cls: "sp-log" });

		this.taskResultEl = card.createDiv({ cls: "sp-results" });

		// 手动获取按钮引用，用于运行时禁用
		this.startBtn = manualBtn;

		this.built = true;
		this.renderedLog = 0;
		this.syncSearchClear();
		this.renderResults();
	}

	private syncSearchClear(): void {
		this.searchClearBtn?.toggleClass("sp-hidden", this.searchInput.value.length === 0);
	}

	private buildTabs(): void {
		this.tabsEl.empty();
		const defs: [Tab, string, number][] = [
			["all", "全部", this.podcasts.length + this.episodes.length],
			["podcasts", "播客", this.podcasts.length],
			["episodes", "单集", this.episodes.length],
		];
		for (const [key, label, count] of defs) {
			const b = this.tabsEl.createEl("button", { cls: "sp-tab" });
			b.createSpan({ text: label });
			if (count > 0) b.createSpan({ text: String(count), cls: "sp-tab-count" });
			b.toggleClass("is-active", this.tab === key);
			b.onclick = () => {
				this.tab = key;
				this.buildTabs();
				this.renderResults();
			};
		}
	}

	private async doSearch(): Promise<void> {
		const term = this.searchInput.value.trim();
		if (!term) return;
		this.searching = true;
		this.searchError = "";
		this.drillPodcast = null;
		this.drillEpisodes = null;
		this.detailEpisode = null;
		this.renderResults();
		try {
			const [pods, eps] = await Promise.all([searchPodcasts(term, 6), searchEpisodes(term, 12)]);
			this.podcasts = pods;
			this.episodes = eps;
		} catch (e) {
			this.searchError = `搜索失败：${String(e)}`;
			this.podcasts = [];
			this.episodes = [];
		} finally {
			this.searching = false;
			this.renderResults();
		}
	}

	private async drillInto(podcast: PodcastResult): Promise<void> {
		this.drillPodcast = podcast;
		this.drillEpisodes = null;
		this.detailEpisode = null;
		this.searching = true;
		this.renderResults();
		try {
			this.drillEpisodes = await lookupEpisodes(podcast.collectionId, 30);
		} catch (e) {
			this.searchError = `拉取单集失败：${String(e)}`;
			this.drillEpisodes = [];
		} finally {
			this.searching = false;
			this.renderResults();
		}
	}

	private drillIntoEpisode(ep: EpisodeResult): void {
		this.detailEpisode = ep;
		this.renderResults();
	}

	private renderResults(): void {
		const el = this.resultsEl;
		el.empty();

		// 标签仅在有搜索结果、且不在详情/下钻/搜索中/出错时显示。
		const showTabs =
			!this.searching &&
			!this.searchError &&
			!this.drillPodcast &&
			!this.detailEpisode &&
			(this.podcasts.length > 0 || this.episodes.length > 0);
		this.tabsEl.toggleClass("sp-hidden", !showTabs);
		if (showTabs) this.buildTabs();
		else this.tabsEl.empty();

		if (this.searching) {
			this.renderLoading(el, this.drillPodcast ? "拉取单集…" : "搜索中…");
			return;
		}
		if (this.searchError) {
			this.renderNotice(el, "alert-triangle", this.searchError, true);
			return;
		}

		// 分支 1：正在查看某个单集的详细介绍
		if (this.detailEpisode) {
			this.renderEpisodeDetail(el, this.detailEpisode);
			return;
		}

		// 分支 2：下钻进入某个播客的单集列表
		if (this.drillPodcast) {
			const cameFromSearch = this.podcasts.length > 0 || this.episodes.length > 0;
			const back = el.createEl("button", { cls: "sp-back" });
			setIcon(back.createSpan({ cls: "sp-back-icon" }), "arrow-left");
			back.createSpan({ text: cameFromSearch ? "返回搜索结果" : "返回我的播客" });
			back.onclick = () => {
				this.drillPodcast = null;
				this.drillEpisodes = null;
				this.renderResults();
			};

			// 标题行 + 关注按钮
			const titleRow = el.createDiv({ cls: "sp-drill-head" });
			titleRow.createSpan({ text: this.drillPodcast.name, cls: "sp-drill-name" });
			this.renderFollowButton(titleRow, this.drillPodcast);

			const eps = this.drillEpisodes ?? [];
			if (eps.length === 0) {
				this.renderNotice(el, "inbox", "这档播客没有找到可获取的单集。");
			} else {
				for (const ep of eps) this.renderEpisode(el, ep);
			}
			return;
		}

		// 分支 3：未发起搜索时，展示「我的播客」
		const hasSearched = this.podcasts.length > 0 || this.episodes.length > 0;
		if (!hasSearched) {
			this.renderMyPodcasts(el);
			return;
		}

		// 分支 4：搜索结果列表
		if (this.tab !== "episodes" && this.podcasts.length > 0) {
			this.renderSectionTitle(el, "播客", "点开看这档播客的单集");
			for (const p of this.podcasts) this.renderPodcast(el, p);
		}
		if (this.tab !== "podcasts" && this.episodes.length > 0) {
			this.renderSectionTitle(el, "单集", "点击卡片看介绍，右侧直接获取");
			for (const ep of this.episodes) this.renderEpisode(el, ep);
		}
	}

	private renderSectionTitle(parent: HTMLElement, text: string, hint?: string): void {
		const row = parent.createDiv({ cls: "sp-section-title" });
		row.createSpan({ text });
		if (hint) row.createSpan({ text: hint, cls: "sp-section-hint" });
	}

	private renderLoading(parent: HTMLElement, text: string): void {
		const wrap = parent.createDiv({ cls: "sp-loading" });
		setIcon(wrap.createSpan({ cls: "sp-spin" }), "loader");
		wrap.createSpan({ text });
	}

	private renderNotice(parent: HTMLElement, icon: string, text: string, isError = false): void {
		const wrap = parent.createDiv({ cls: isError ? "sp-notice sp-notice-error" : "sp-notice" });
		setIcon(wrap.createSpan({ cls: "sp-notice-icon" }), icon);
		wrap.createSpan({ text });
	}

	/** 首页：我的播客（关注的固定几档，点进去看最新集直接获取） */
	private renderMyPodcasts(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: "sp-home" });
		const followed = this.plugin.settings.followedPodcasts;

		if (followed.length === 0) {
			const emptyBox = wrap.createDiv({ cls: "sp-empty" });
			setIcon(emptyBox.createDiv({ cls: "sp-empty-icon" }), "audio-lines");
			emptyBox.createDiv({ text: "还没有关注的播客", cls: "sp-empty-title" });
			emptyBox.createDiv({
				text: "在上方搜索你常听的播客，点「关注」后就会固定在这里，下次点开直接查看最新单集并获取文字稿。",
				cls: "sp-empty-desc",
			});
			return;
		}

		this.renderSectionTitle(wrap, "我的播客", "点开看最新单集");
		for (const p of followed) {
			this.renderPodcast(wrap, p);
		}
	}

	/** 关注 / 取关按钮（下钻页标题旁的主按钮样式）。 */
	private renderFollowButton(parent: HTMLElement, podcast: PodcastResult): void {
		const followed = this.plugin.isFollowed(podcast.collectionId);
		const btn = parent.createEl("button", {
			cls: `sp-follow-btn ${followed ? "is-followed" : ""}`,
		});
		setIcon(btn.createSpan({ cls: "sp-follow-icon" }), followed ? "check" : "plus");
		btn.createSpan({ text: followed ? "已关注" : "关注" });
		btn.setAttr("title", followed ? "取消关注" : "关注这档播客，固定到首页");
		btn.onclick = async (e) => {
			e.stopPropagation();
			await this.plugin.toggleFollow(podcast);
			this.renderResults();
		};
	}

	/** 单集详情介绍页（核心下钻视图：支持先看 Show Notes 判断再获取） */
	private renderEpisodeDetail(parent: HTMLElement, ep: EpisodeResult): void {
		const wrap = parent.createDiv({ cls: "sp-ep-detail" });

		// 返回按钮
		const back = wrap.createEl("button", { cls: "sp-back" });
		setIcon(back.createSpan({ cls: "sp-back-icon" }), "arrow-left");
		const hasSearched = this.podcasts.length > 0 || this.episodes.length > 0;
		const backText = this.drillPodcast
			? "返回单集列表"
			: hasSearched
				? "返回搜索结果"
				: "返回我的播客";
		back.createSpan({ text: backText });
		back.onclick = () => {
			this.detailEpisode = null;
			this.renderResults();
		};

		// 头部信息
		const header = wrap.createDiv({ cls: "sp-ep-header" });
		if (ep.artwork) {
			header.createEl("img", { cls: "sp-ep-art", attr: { src: ep.artwork, alt: "" } });
		} else {
			const ph = header.createDiv({ cls: "sp-ep-art sp-ep-art-ph" });
			setIcon(ph, "podcast");
		}

		const headerInfo = header.createDiv({ cls: "sp-ep-info" });
		if (ep.podcast) {
			const podRow = headerInfo.createDiv({ cls: "sp-ep-pod-row" });
			setIcon(podRow.createSpan({ cls: "sp-ep-pod-icon" }), "mic");
			const podName = podRow.createSpan({ text: ep.podcast, cls: "sp-ep-pod-name" });
			podName.setAttr("title", `搜索《${ep.podcast}》`);
			podName.onclick = () => {
				this.detailEpisode = null;
				this.drillPodcast = null;
				this.searchInput.value = ep.podcast;
				this.syncSearchClear();
				void this.doSearch();
			};
		}
		headerInfo.createDiv({ text: ep.title, cls: "sp-ep-title" });

		const metaRow = headerInfo.createDiv({ cls: "sp-ep-meta" });
		if (ep.date) metaRow.createSpan({ text: ep.date, cls: "sp-ep-meta-item" });
		if (ep.duration) {
			const mins = Math.round(ep.duration / 60);
			metaRow.createSpan({ text: `${mins} 分钟`, cls: "sp-ep-meta-item" });
		}
		if (ep.source === "scripod") {
			metaRow.createSpan({ text: "⚡ 秒级出稿", cls: "sp-ep-tag-fast" });
		}

		// 操作栏（醒目的主获取按钮）
		const actionRow = wrap.createDiv({ cls: "sp-ep-actions" });
		const isRunning = this.plugin.task.status === "running";
		const fetchBtn = actionRow.createEl("button", {
			cls: "mod-cta sp-ep-fetch-btn",
		});
		fetchBtn.disabled = isRunning || !ep.audioUrl;
		setIcon(fetchBtn.createSpan({ cls: "sp-ep-fetch-icon" }), ep.source === "scripod" ? "zap" : "download");
		fetchBtn.createSpan({
			text: isRunning
				? "正在获取中…"
				: ep.source === "scripod"
					? "⚡ 秒取文字稿（现成字幕）"
					: "获取文字稿",
		});
		fetchBtn.onclick = () => this.pickEpisode(ep);

		// 节目介绍 / Show Notes 容器
		const descSection = wrap.createDiv({ cls: "sp-ep-desc-section" });
		this.renderSectionTitle(descSection, "节目介绍 / Show Notes");
		const descBox = descSection.createDiv({ cls: "sp-ep-desc" });

		if (ep.description && ep.description.trim()) {
			const paras = ep.description.split(/\n+/).map((p) => p.trim()).filter(Boolean);
			if (paras.length > 0) {
				for (const p of paras) {
					descBox.createEl("p", { text: p, cls: "sp-ep-para" });
				}
			} else {
				descBox.createEl("p", { text: ep.description, cls: "sp-ep-para" });
			}
		} else {
			descBox.createDiv({
				cls: "sp-ep-desc-empty",
				text: "该单集未附带详细介绍。你可以直接点击上方按钮获取文字稿阅读。",
			});
		}
	}

	private renderPodcast(parent: HTMLElement, p: PodcastResult): void {
		const item = parent.createDiv({ cls: "sp-item sp-item-podcast" });
		item.setAttr("role", "button");
		item.setAttr("aria-label", `查看《${p.name}》的单集`);
		this.renderArt(item, p.artwork);
		const main = item.createDiv({ cls: "sp-item-main" });
		main.createDiv({ text: p.name, cls: "sp-item-title" });
		if (p.author) main.createDiv({ text: p.author, cls: "sp-item-sub" });

		// 星标：一眼关注 / 取关（阻止冒泡，避免触发下钻）
		const followed = this.plugin.isFollowed(p.collectionId);
		const star = item.createSpan({
			cls: `sp-item-action sp-item-star ${followed ? "is-followed" : ""}`,
		});
		star.setAttr("title", followed ? "取消关注" : "关注这档播客");
		setIcon(star, followed ? "star" : "star");
		star.onclick = async (e) => {
			e.stopPropagation();
			await this.plugin.toggleFollow(p);
			this.renderResults();
		};

		setIcon(item.createSpan({ cls: "sp-item-action sp-item-chevron" }), "chevron-right");
		item.onclick = () => void this.drillInto(p);
	}

	private renderEpisode(parent: HTMLElement, ep: EpisodeResult): void {
		const item = parent.createDiv({ cls: "sp-item sp-item-episode" });
		const usable = !!ep.audioUrl;
		item.toggleClass("is-disabled", !usable);
		item.setAttr("role", "button");
		item.setAttr("aria-label", usable ? `查看《${ep.title}》介绍与获取` : "该单集无可用音频");
		this.renderArt(item, ep.artwork);
		const main = item.createDiv({ cls: "sp-item-main" });
		main.createDiv({ text: ep.title, cls: "sp-item-title" });

		const metaParts: string[] = [];
		if (ep.podcast) metaParts.push(ep.podcast);
		if (ep.duration) {
			const m = Math.round(ep.duration / 60);
			metaParts.push(`${m} 分钟`);
		}
		if (ep.date) metaParts.push(ep.date);
		const sub = metaParts.filter(Boolean).join(" · ");
		if (sub) main.createDiv({ text: sub, cls: "sp-item-sub" });

		// 点击主体：下钻进入单集详情介绍页，供用户初步判断
		item.onclick = () => this.drillIntoEpisode(ep);

		// 右侧快捷获取图标（阻止冒泡，避免进入详情）
		const action = item.createSpan({ cls: "sp-item-action sp-item-fetch" });
		action.setAttr("title", "直接获取文字稿");
		setIcon(action, usable ? "download" : "ban");
		if (usable) {
			action.onclick = (e) => {
				e.stopPropagation();
				this.pickEpisode(ep);
			};
		}
	}

	private renderArt(item: HTMLElement, url: string): void {
		if (url) {
			item.createEl("img", { cls: "sp-item-art", attr: { src: url, alt: "", loading: "lazy" } });
		} else {
			const ph = item.createDiv({ cls: "sp-item-art sp-item-art-ph" });
			setIcon(ph, "podcast");
		}
	}

	private pickEpisode(ep: EpisodeResult): void {
		if (!ep.audioUrl) return;
		// 标题优先：先让脚本拿标题去 scripod/YouTube 找现成字幕（快）；
		// 找不到再退回 mp3 直链本地 whisper 转写（慢但精确、不会认错集）。
		const primary = ep.title?.trim() || ep.audioUrl;
		const fallback = primary === ep.audioUrl ? undefined : ep.audioUrl;
		this.plugin.submitFetch(
			[primary],
			this.plugin.settings.asrModel,
			{
				title: ep.title,
				podcast: ep.podcast,
			},
			fallback,
		);
	}

	private submitManual(): void {
		const inputs = this.manualValue
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (inputs.length === 0) return;
		this.plugin.submitFetch(inputs, this.plugin.settings.asrModel);
	}

	/** 供插件在状态变化时调用。 */
	update(): void {
		if (!this.built) this.build();
		const task = this.plugin.task;
		const running = task.status === "running";

		// 空闲且没有任何历史结果时，整张卡片隐藏，保持面板清爽。
		const showCard = task.status !== "idle";
		this.taskCardEl.toggleClass("sp-hidden", !showCard);
		this.taskCardEl.dataset.status = task.status;

		this.statusEl.setText(STATUS_TEXT[task.status]);
		this.updateElapsed();

		this.progressEl.toggleClass("sp-hidden", !running);
		this.cancelBtn.toggleClass("sp-hidden", !running);
		this.startBtn.disabled = running;

		// 运行时把最新一行日志顶出来，让用户一眼看到"还在动"。
		const lastLine = task.log.length > 0 ? task.log[task.log.length - 1] : "";
		this.liveLineEl.toggleClass("sp-hidden", !(running && !!lastLine));
		if (running) this.liveLineEl.setText(lastLine);

		this.taskInputEl.empty();
		if (running && task.inputs.length > 0) {
			const box = this.taskInputEl.createDiv({ cls: "sp-inputs-box" });
			box.createDiv({ text: `处理中 · 共 ${task.inputs.length} 条`, cls: "sp-inputs-head" });
			for (const input of task.inputs) {
				box.createDiv({ text: input, cls: "sp-input-item" });
			}
		}

		// 增量渲染日志。
		if (task.log.length < this.renderedLog) {
			this.logEl.empty();
			this.renderedLog = 0;
		}
		for (let i = this.renderedLog; i < task.log.length; i++) {
			this.logEl.createDiv({ text: task.log[i], cls: "sp-log-line" });
		}
		this.renderedLog = task.log.length;
		this.logEl.scrollTop = this.logEl.scrollHeight;
		this.logDetailsEl.toggleClass("sp-hidden", task.log.length === 0);
		this.logSummaryEl.setText(`运行日志 · ${task.log.length} 行`);

		this.taskResultEl.empty();
		if (task.errorText) {
			this.renderNotice(this.taskResultEl, "alert-triangle", task.errorText, true);
			if (task.canRetry) {
				const retryBox = this.taskResultEl.createDiv({ cls: "sp-error-action" });
				const retryBtn = retryBox.createEl("button", { cls: "mod-cta sp-retry" });
				setIcon(retryBtn.createSpan({ cls: "sp-retry-icon" }), "rotate-ccw");
				retryBtn.createSpan({ text: "重试" });
				retryBtn.onclick = () => this.plugin.retryLastFetch();
			}
			if (
				task.errorText.includes("环境") ||
				task.errorText.includes("Python") ||
				task.errorText.includes("依赖") ||
				task.errorText.includes("venv")
			) {
				const guide = this.taskResultEl.createDiv({ cls: "sp-error-action" });
				guide.style.marginTop = "8px";
				const btn = guide.createEl("button", { text: "打开插件设置检查 / 修复环境", cls: "mod-cta" });
				btn.onclick = () => {
					const setting = (this.plugin.app as unknown as { setting?: { open: () => void; openTabById?: (id: string) => void } }).setting;
					if (setting?.open) {
						setting.open();
						setting.openTabById?.(this.plugin.manifest.id);
					}
				};
			}
		}
		if (task.results.length > 0) {
			this.taskResultEl.createDiv({ text: "生成的文字稿笔记", cls: "sp-results-head" });
			for (const r of task.results) {
				const link = this.taskResultEl.createEl("a", { cls: "sp-result-link" });
				setIcon(link.createSpan({ cls: "sp-result-icon" }), "file-text");
				link.createSpan({ text: r.name, cls: "sp-result-name" });
				setIcon(link.createSpan({ cls: "sp-result-open" }), "arrow-up-right");
				link.onclick = (e) => {
					e.preventDefault();
					const file = this.plugin.app.vault.getAbstractFileByPath(r.path);
					if (file instanceof TFile) this.plugin.app.workspace.getLeaf(true).openFile(file);
				};
			}
		}
	}

	private updateElapsed(): void {
		const task = this.plugin.task;
		if (!task.startedAt) {
			this.elapsedEl.setText("");
			return;
		}
		const end = task.status === "running" ? Date.now() : task.endedAt ?? Date.now();
		const secs = Math.max(0, Math.floor((end - task.startedAt) / 1000));
		const mm = String(Math.floor(secs / 60)).padStart(2, "0");
		const ss = String(secs % 60).padStart(2, "0");
		const prefix = task.status === "running" ? "已用" : "用时";
		this.elapsedEl.setText(`${prefix} ${mm}:${ss}`);
	}
}
