import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import scriptSource from "../scripts/podcast_transcript_txt.py";
import { LONGHAI_PODSCRIPT_HOME } from "./env";

/** 内置转写脚本释放到本地数据目录后的固定路径（在库外，不随库同步、不被插件更新清空）。 */
export const BUNDLED_SCRIPT_PATH = join(LONGHAI_PODSCRIPT_HOME, "podcast_transcript_txt.py");

/**
 * 把打包进 main.js 的转写脚本释放到本地数据目录，并返回其路径。
 * 官方商店安装只会下载 main.js/manifest.json/styles.css，不含 scripts/ 目录，
 * 因此运行时需要从内联文本把脚本落盘。内容与内置版本不一致时（插件升级）自动覆盖。
 */
export function ensureBundledScript(): string {
	mkdirSync(LONGHAI_PODSCRIPT_HOME, { recursive: true });
	let needWrite = true;
	if (existsSync(BUNDLED_SCRIPT_PATH)) {
		try {
			needWrite = readFileSync(BUNDLED_SCRIPT_PATH, "utf8") !== scriptSource;
		} catch {
			needWrite = true;
		}
	}
	if (needWrite) {
		writeFileSync(BUNDLED_SCRIPT_PATH, scriptSource, "utf8");
	}
	return BUNDLED_SCRIPT_PATH;
}
