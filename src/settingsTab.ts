import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type LonghaiPodscriptPlugin from "./main";
import { resolveScriptPath } from "./runner";
import { getVenvPaths, runEnvDoctor, ensureEnvReady, type DoctorReport } from "./env";

export class LonghaiPodscriptSettingTab extends PluginSettingTab {
	private readonly plugin: LonghaiPodscriptPlugin;

	constructor(app: App, plugin: LonghaiPodscriptPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const resolved = resolveScriptPath(this.plugin.settings.scriptPath);
		const venvPaths = getVenvPaths();

		new Setting(containerEl)
			.setName("系统 Python 解释器")
			.setDesc("默认留空自动探测（要求 Python 3.9+）。仅在需要指定特定系统 Python 来创建隔离虚拟环境时填写。")
			.addText((t) =>
				t
					.setPlaceholder("留空自动探测（推荐）")
					.setValue(this.plugin.settings.pythonPath)
					.onChange(async (v) => {
						this.plugin.settings.pythonPath = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("pip 镜像源（可选）")
			.setDesc("国内网络下载依赖慢时可填写镜像源加速，例如：https://pypi.tuna.tsinghua.edu.cn/simple")
			.addText((t) =>
				t
					.setPlaceholder("留空使用官方 PyPI 源")
					.setValue(this.plugin.settings.pipIndexUrl || "")
					.onChange(async (v) => {
						this.plugin.settings.pipIndexUrl = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("文字稿保存文件夹")
			.setDesc("库内相对路径，不存在会自动创建。")
			.addText((t) =>
				t
					.setPlaceholder("播客文字稿")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (v) => {
						this.plugin.settings.outputFolder = v.trim() || "播客文字稿";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("转写模型（whisper）")
			.setDesc("获取时统一使用此模型；仅在无现成字幕、需音频转写时才会真正用到。small 更快，medium 术语更稳。")
			.addDropdown((dd) =>
				dd
					.addOption("small", "small（快，出初稿）")
					.addOption("medium", "medium（慢，术语更准）")
					.setValue(this.plugin.settings.asrModel)
					.onChange(async (v) => {
						this.plugin.settings.asrModel = v as "small" | "medium";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("生成后自动打开笔记")
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.openAfterCreate).onChange(async (v) => {
					this.plugin.settings.openAfterCreate = v;
					await this.plugin.saveSettings();
				}),
			);

		// 隔离环境与依赖管理区域
		containerEl.createEl("h3", { text: "独立虚拟环境与依赖状态" });
		const envDescEl = containerEl.createDiv({ cls: "setting-item-description sp-env-intro" });
		envDescEl.setText("插件自管独立的 Python 虚拟环境（位于 ~/.longhai-podscript），依赖与模型缓存完全隔离，不污染系统全局环境。");

		// 结构化状态看板容器
		const cardEl = containerEl.createDiv({ cls: "sp-env-card" });
		let latestReport: DoctorReport | null = null;
		let installLog = "";

		const renderCard = (loadingMsg: string | null, detailsOpen = false) => {
			this.renderEnvBoard(cardEl, latestReport, loadingMsg, installLog, detailsOpen);
		};

		// 初次进入时显示探测中，并自动执行一次轻量自检以呈现看板
		renderCard("正在检测运行环境状态…");
		void runEnvDoctor(resolved, this.plugin.settings.pythonPath).then((rep) => {
			latestReport = rep;
			renderCard(null, !rep.allOk && !rep.venvOk);
		});

		new Setting(containerEl)
			.setName("环境操作")
			.setDesc("运行环境自检，或在缺少依赖时一键安装/修复。")
			.addButton((btn) =>
				btn.setButtonText("运行自检").onClick(async () => {
					btn.setDisabled(true).setButtonText("自检中…");
					renderCard("正在执行完整自检，请稍候…");
					try {
						const rep = await runEnvDoctor(resolved, this.plugin.settings.pythonPath);
						latestReport = rep;
						const allOk = rep.scriptOk && rep.systemPythonOk && rep.venvOk && rep.ytdlpOk && rep.whisperOk;
						renderCard(null, !allOk);
						new Notice(allOk ? "自检通过 ✅ 运行环境就绪！" : "自检发现缺失项 ⚠️ 请查看下方卡片", allOk ? 4000 : 8000);
					} catch (e) {
						renderCard(null, true);
						new Notice(`自检出错: ${String(e)}`, 8000);
					} finally {
						btn.setDisabled(false).setButtonText("运行自检");
					}
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("安装 / 修复依赖")
					.setCta()
					.onClick(async () => {
						// 用户主动点击安装，即视为明确同意联网准备环境，后续获取不再弹窗。
						if (!this.plugin.settings.depsConsent) {
							this.plugin.settings.depsConsent = true;
							await this.plugin.saveSettings();
						}
						btn.setDisabled(true).setButtonText("准备环境中…");
						installLog = "开始准备隔离虚拟环境并安装核心依赖…\n";
						renderCard("正在配置虚拟环境并下载依赖（yt-dlp, faster-whisper）…", true);
						try {
							const res = await ensureEnvReady({
								configuredPython: this.plugin.settings.pythonPath,
								pipIndexUrl: this.plugin.settings.pipIndexUrl,
								onLine: (line) => {
									installLog += line + "\n";
									renderCard("正在配置虚拟环境并下载依赖（yt-dlp, faster-whisper）…", true);
								},
							});
							if (res.ok) {
								new Notice("环境与依赖已成功准备就绪 ✅", 5000);
								installLog += "\n✅ 环境配置就绪！\n";
								const rep = await runEnvDoctor(resolved, this.plugin.settings.pythonPath);
								latestReport = rep;
								renderCard(null, false);
							} else {
								new Notice(`环境准备失败：${res.error?.slice(0, 100)}`, 10000);
								installLog += `\n❌ 准备失败：\n${res.error}\n`;
								renderCard(null, true);
							}
						} catch (e) {
							new Notice(`发生异常：${String(e)}`, 10000);
							installLog += `\n❌ 异常：${String(e)}\n`;
							renderCard(null, true);
						} finally {
							btn.setDisabled(false).setButtonText("安装 / 修复依赖");
						}
					}),
			);
	}

	/** 绘制结构化、优雅清爽的环境看板卡片 */
	private renderEnvBoard(
		cardEl: HTMLElement,
		report: DoctorReport | null,
		loadingMsg: string | null,
		rawLog: string,
		detailsOpen = false,
	): void {
		cardEl.empty();

		if (loadingMsg) {
			const hero = cardEl.createDiv({ cls: "sp-env-hero sp-env-hero-warn" });
			hero.createDiv({ text: "⏳", cls: "sp-env-hero-icon" });
			const content = hero.createDiv({ cls: "sp-env-hero-content" });
			content.createDiv({ text: "正在检查 / 准备环境…", cls: "sp-env-hero-title" });
			content.createDiv({ text: loadingMsg, cls: "sp-env-hero-desc" });
			if (rawLog.trim()) {
				const details = cardEl.createEl("details", { cls: "sp-env-details" });
				if (detailsOpen) details.setAttr("open", "true");
				details.createEl("summary", { text: "安装日志与详细输出" });
				const logView = details.createDiv({ cls: "sp-env-log-view", text: rawLog.trim() });
				logView.scrollTop = logView.scrollHeight;
			}
			return;
		}

		if (!report) {
			const hero = cardEl.createDiv({ cls: "sp-env-hero" });
			hero.createDiv({ text: "🔍", cls: "sp-env-hero-icon" });
			const content = hero.createDiv({ cls: "sp-env-hero-content" });
			content.createDiv({ text: "尚未检测环境状态", cls: "sp-env-hero-title" });
			content.createDiv({ text: "请点击下方「运行自检」查看当前运行环境与依赖完整情况。", cls: "sp-env-hero-desc" });
			return;
		}

		const allOk = report.scriptOk && report.systemPythonOk && report.venvOk && report.ytdlpOk && report.whisperOk;

		// 顶部 Hero
		const hero = cardEl.createDiv({ cls: `sp-env-hero ${allOk ? "sp-env-hero-ok" : "sp-env-hero-warn"}` });
		hero.createDiv({ text: allOk ? "🟢" : "⚠️", cls: "sp-env-hero-icon" });
		const content = hero.createDiv({ cls: "sp-env-hero-content" });
		content.createDiv({
			text: allOk ? "运行环境就绪" : "环境依赖未完全就绪",
			cls: "sp-env-hero-title",
		});
		content.createDiv({
			text: allOk
				? "独立 Python 虚拟环境与核心依赖均已齐备，可直接获取文字稿。"
				: "检测到部分依赖或虚拟环境缺失，请点击下方「安装 / 修复依赖」。",
			cls: "sp-env-hero-desc",
		});

		// 6个核心组件网格看板
		const grid = cardEl.createDiv({ cls: "sp-env-grid" });

		const addItem = (icon: string, label: string, statusText: string, ok: boolean) => {
			const item = grid.createDiv({ cls: "sp-env-item" });
			const left = item.createDiv({ cls: "sp-env-item-label" });
			left.createSpan({ text: icon });
			left.createSpan({ text: label });
			item.createSpan({
				cls: `sp-env-item-badge ${ok ? "sp-badge-ok" : "sp-badge-fail"}`,
				text: `${statusText} ${ok ? "✅" : "❌"}`,
			});
		};

		addItem(
			"🐍",
			"系统 Python",
			report.systemPythonOk ? (report.systemPythonVersion ? `Python ${report.systemPythonVersion}` : "就绪") : "未检测到",
			report.systemPythonOk,
		);

		addItem(
			"📦",
			"隔离虚拟环境",
			report.venvOk ? "已就绪" : "未创建",
			report.venvOk,
		);

		addItem(
			"⚡",
			"媒体下载 (yt-dlp)",
			report.ytdlpOk ? "已就绪" : "未安装",
			report.ytdlpOk,
		);

		addItem(
			"🎙️",
			"语音转写 (whisper)",
			report.whisperOk ? (report.whisperVersion ? `v${report.whisperVersion}` : "已就绪") : "未安装",
			report.whisperOk,
		);

		addItem(
			"📜",
			"转写核心脚本",
			report.scriptOk ? "插件内置就绪" : "未找到",
			report.scriptOk,
		);

		addItem(
			"📁",
			"本地模型缓存",
			report.modelsDirOk ? "就绪" : "不可写",
			report.modelsDirOk,
		);

		// 折叠详细技术信息
		const details = cardEl.createEl("details", { cls: "sp-env-details" });
		if (detailsOpen || !allOk) details.setAttr("open", "true");
		details.createEl("summary", { text: "查看存储路径与诊断输出" });

		const infoLines: string[] = [
			`• 虚拟环境目录: ${report.venvPath}`,
			`• 模型缓存目录: ${report.modelsDirPath}`,
			`• 核心脚本路径: ${report.scriptPath || "未定位"}`,
		];
		if (report.systemPythonPath) {
			infoLines.push(`• 系统 Python: ${report.systemPythonPath} (${report.systemPythonVersion || ""})`);
		}
		if (rawLog.trim()) {
			infoLines.push("\n--- 执行与安装日志 ---");
			infoLines.push(rawLog.trim());
		}

		const logView = details.createDiv({ cls: "sp-env-log-view", text: infoLines.join("\n") });
		logView.scrollTop = logView.scrollHeight;
	}
}

