export type AsrModel = "small" | "medium";

/** 用户关注的播客（结构与 search.ts 的 PodcastResult 对齐，便于直接下钻拉最新集）。 */
export interface FollowedPodcast {
	collectionId: number;
	name: string;
	author: string;
	artwork: string;
	feedUrl: string;
}

export interface LonghaiPodscriptSettings {
	/** 自定义指定 podcast_transcript_txt.py 路径；留空则默认使用插件自带脚本。 */
	scriptPath: string;
	/** 系统 Python 解释器（默认留空自动探测；仅在需手动指定引导 venv 的系统 Python 时填写）。 */
	pythonPath: string;
	/** （可选）pip 镜像源，如 https://pypi.tuna.tsinghua.edu.cn/simple，留空使用官方源。 */
	pipIndexUrl: string;
	/** 文字稿笔记落库的库内文件夹（相对 vault 根）。 */
	outputFolder: string;
	/** 走音频回退时使用的 ASR 模型。 */
	asrModel: AsrModel;
	/** 生成后自动打开笔记。 */
	openAfterCreate: boolean;
	/** 我的播客：用户关注的固定几档，首页直接列出。 */
	followedPodcasts: FollowedPodcast[];
}

export const DEFAULT_SETTINGS: LonghaiPodscriptSettings = {
	scriptPath: "",
	pythonPath: "",
	pipIndexUrl: "",
	outputFolder: "播客文字稿",
	asrModel: "small",
	openAfterCreate: true,
	followedPodcasts: [],
};

