import { App, Modal, Setting } from "obsidian";

/**
 * 首次需要联网准备本地转写环境时，弹窗明确告知将要发生的操作并征得用户同意。
 * 返回 true 表示用户同意继续；false 表示取消或直接关闭。
 */
export function confirmDepsConsent(app: App): Promise<boolean> {
	return new Promise((resolve) => {
		new DepsConsentModal(app, resolve).open();
	});
}

class DepsConsentModal extends Modal {
	private decided = false;
	private readonly onDecision: (agreed: boolean) => void;

	constructor(app: App, onDecision: (agreed: boolean) => void) {
		super(app);
		this.onDecision = onDecision;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("首次使用：准备本地转写环境");

		contentEl.createEl("p", {
			text: "为了在本地把播客音频转成文字，插件需要在你电脑上准备一个独立运行环境。首次使用会执行以下操作，全部在本地完成，不会上传你的任何数据：",
		});

		const list = contentEl.createEl("ul");
		list.createEl("li", {
			text: "调用你系统里的 Python 3.9+，在 ~/.longhai-podscript 目录下创建一个独立的虚拟环境（不影响系统 Python）。",
		});
		list.createEl("li", {
			text: "联网用 pip 从 PyPI 下载并安装两个开源工具：yt-dlp（下载媒体）和 faster-whisper（本地语音识别）。",
		});
		list.createEl("li", {
			text: "遇到没有现成字幕的音频时，会联网下载一次 Whisper 语音模型（约 500MB–1.5GB），缓存到本地供后续复用。",
		});

		contentEl.createEl("p", {
			text: "以上依赖与模型都安装在库外的 ~/.longhai-podscript，不会污染系统环境，也不会随笔记库同步或被插件更新清空。你也可以在设置里填写 pip 镜像源加速下载。",
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("取消").onClick(() => {
					this.finish(false);
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("同意并继续")
					.setCta()
					.onClick(() => {
						this.finish(true);
					}),
			);
	}

	private finish(agreed: boolean): void {
		if (this.decided) return;
		this.decided = true;
		this.onDecision(agreed);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		// 未点任何按钮直接关闭（点遮罩/Esc）视为取消。
		if (!this.decided) {
			this.decided = true;
			this.onDecision(false);
		}
	}
}
