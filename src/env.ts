import { spawn, ChildProcess } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

export const LONGHAI_PODSCRIPT_HOME = join(homedir(), ".longhai-podscript");
export const VENV_DIR = join(LONGHAI_PODSCRIPT_HOME, "venv");
export const MODELS_DIR = join(LONGHAI_PODSCRIPT_HOME, "models");

const isWin = platform() === "win32";

export interface VenvPaths {
	venvDir: string;
	python: string;
	ytdlp: string;
	pip: string;
	binDir: string;
	modelsDir: string;
}

export function getVenvPaths(customVenvDir = VENV_DIR): VenvPaths {
	const binDir = isWin ? join(customVenvDir, "Scripts") : join(customVenvDir, "bin");
	const python = isWin ? join(binDir, "python.exe") : join(binDir, "python");
	const ytdlp = isWin ? join(binDir, "yt-dlp.exe") : join(binDir, "yt-dlp");
	const pip = isWin ? join(binDir, "pip.exe") : join(binDir, "pip");
	return {
		venvDir: customVenvDir,
		python,
		ytdlp,
		pip,
		binDir,
		modelsDir: MODELS_DIR,
	};
}

export interface PythonDetectResult {
	ok: boolean;
	path?: string;
	version?: string;
	error?: string;
	installHelp?: string;
}

/** 生成针对当前操作系统的 Python 安装引导说明。 */
export function getPythonInstallGuide(): string {
	if (isWin) {
		return (
			"未检测到可用的 Python 3.9+ 环境。\n\n" +
			"推荐安装方式：\n" +
			"1. 前往 Python 官方网站下载安装包：https://www.python.org/downloads/\n" +
			"   ⚠️ 安装时务必勾选底部【Add python.exe to PATH】选项！\n" +
			"2. 或在 Microsoft Store 中搜索并安装 Python 3.11 或 3.12。"
		);
	}
	if (platform() === "darwin") {
		return (
			"未检测到可用的 Python 3.9+ 环境。\n\n" +
			"推荐安装方式：\n" +
			"1. 若安装了 Homebrew，请在终端（Terminal）运行：\n" +
			"   brew install python\n" +
			"2. 或前往官网下载安装包：https://www.python.org/downloads/mac-osx/"
		);
	}
	return (
		"未检测到可用的 Python 3.9+ 环境。\n\n" +
		"请使用 Linux 系统的包管理器安装，例如：\n" +
		"sudo apt update && sudo apt install -y python3 python3-venv python3-pip"
	);
}

/**
 * 探测可用的系统 Python 解释器（必须满足 Python 3.9+）。
 */
export async function detectSystemPython(configured?: string): Promise<PythonDetectResult> {
	const candidates: string[] = [];
	if (configured && configured.trim()) {
		candidates.push(configured.trim());
	}
	candidates.push("python3", "python");

	if (platform() === "darwin") {
		candidates.push(
			"/opt/homebrew/bin/python3",
			"/usr/local/bin/python3",
			"/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
			"/usr/bin/python3",
		);
	} else if (isWin) {
		const localAppData = process.env.LOCALAPPDATA || "";
		if (localAppData) {
			candidates.push(
				join(localAppData, "Programs", "Python", "Python312", "python.exe"),
				join(localAppData, "Programs", "Python", "Python311", "python.exe"),
				join(localAppData, "Programs", "Python", "Python310", "python.exe"),
			);
		}
	}

	const seen = new Set<string>();
	let lastError = "";

	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);

		const res = await checkPythonExecutable(candidate);
		if (res.ok) return res;
		if (res.error) lastError = res.error;
	}

	return {
		ok: false,
		error: lastError || "未在系统 PATH 中找到 Python 解释器。",
		installHelp: getPythonInstallGuide(),
	};
}

function checkPythonExecutable(cmd: string): Promise<PythonDetectResult> {
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let child: ChildProcess;
		try {
			child = spawn(
				cmd,
				[
					"-c",
					"import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
				],
				{ windowsHide: true },
			);
		} catch (e) {
			resolve({ ok: false, error: String(e) });
			return;
		}

		child.stdout?.on("data", (d) => (out += d.toString()));
		child.stderr?.on("data", (d) => (err += d.toString()));
		child.on("error", (e) => resolve({ ok: false, error: e.message }));
		child.on("close", (code) => {
			if (code === 0 && out.trim()) {
				const verStr = out.trim();
				const [major, minor] = verStr.split(".").map((n) => parseInt(n, 10));
				if (!isNaN(major) && !isNaN(minor)) {
					if (major > 3 || (major === 3 && minor >= 9)) {
						resolve({ ok: true, path: cmd, version: verStr });
						return;
					}
					resolve({
						ok: false,
						error: `检测到 Python ${verStr}，版本过低（faster-whisper 需要 Python 3.9+）。`,
					});
					return;
				}
			}
			resolve({ ok: false, error: err.trim() || `退出码 ${code}` });
		});
	});
}

/**
 * 确保虚拟环境存在，若不存在则调用系统 Python 创建。
 */
export function ensureVenv(
	systemPython: string,
	onLine?: (msg: string) => void,
): Promise<{ ok: boolean; error?: string }> {
	const paths = getVenvPaths();
	if (existsSync(paths.python)) {
		return Promise.resolve({ ok: true });
	}

	onLine?.(`正在创建独立虚拟环境：${paths.venvDir}`);
	try {
		mkdirSync(LONGHAI_PODSCRIPT_HOME, { recursive: true });
	} catch (e) {
		return Promise.resolve({ ok: false, error: `无法创建主目录 ${LONGHAI_PODSCRIPT_HOME}: ${String(e)}` });
	}

	return new Promise((resolve) => {
		let err = "";
		let child: ChildProcess;
		try {
			child = spawn(systemPython, ["-m", "venv", paths.venvDir], { windowsHide: true });
		} catch (e) {
			resolve({ ok: false, error: `启动 venv 创建命令失败：${String(e)}` });
			return;
		}

		child.stdout?.on("data", (d) => {
			const s = d.toString().trim();
			if (s) onLine?.(s);
		});
		child.stderr?.on("data", (d) => {
			const s = d.toString().trim();
			if (s) {
				err += s + "\n";
				onLine?.(s);
			}
		});
		child.on("error", (e) => resolve({ ok: false, error: `创建 venv 失败：${e.message}` }));
		child.on("close", (code) => {
			if (code === 0 && existsSync(paths.python)) {
				onLine?.("虚拟环境创建成功 ✅");
				resolve({ ok: true });
			} else {
				resolve({
					ok: false,
					error: `创建 venv 退出码 ${code}。${err.trim() ? "详细：" + err.trim() : ""}`,
				});
			}
		});
	});
}

export interface DepsCheckResult {
	ok: boolean;
	missing: string[];
	versions: Record<string, string>;
	error?: string;
}

/**
 * 检查隔离虚拟环境中是否已经安装了所需依赖（yt-dlp、faster-whisper）。
 */
export function checkDeps(venvPython: string): Promise<DepsCheckResult> {
	if (!existsSync(venvPython)) {
		return Promise.resolve({
			ok: false,
			missing: ["yt-dlp", "faster-whisper"],
			versions: {},
			error: "虚拟环境尚未创建",
		});
	}

	const code = [
		"import sys, json",
		"res = {'missing': [], 'versions': {}}",
		"try:",
		"    import yt_dlp",
		"    res['versions']['yt-dlp'] = getattr(yt_dlp, '__version__', 'ok')",
		"except Exception:",
		"    res['missing'].append('yt-dlp')",
		"try:",
		"    import faster_whisper",
		"    res['versions']['faster-whisper'] = getattr(faster_whisper, '__version__', 'ok')",
		"except Exception:",
		"    res['missing'].append('faster-whisper')",
		"sys.stdout.write(json.dumps(res))",
	].join("\n");

	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let child: ChildProcess;
		try {
			child = spawn(venvPython, ["-c", code], { windowsHide: true });
		} catch (e) {
			resolve({
				ok: false,
				missing: ["yt-dlp", "faster-whisper"],
				versions: {},
				error: String(e),
			});
			return;
		}

		child.stdout?.on("data", (d) => (out += d.toString()));
		child.stderr?.on("data", (d) => (err += d.toString()));
		child.on("error", (e) =>
			resolve({
				ok: false,
				missing: ["yt-dlp", "faster-whisper"],
				versions: {},
				error: e.message,
			}),
		);
		child.on("close", (c) => {
			if (c === 0 && out.trim()) {
				try {
					const parsed = JSON.parse(out.trim()) as {
						missing: string[];
						versions: Record<string, string>;
					};
					resolve({
						ok: parsed.missing.length === 0,
						missing: parsed.missing,
						versions: parsed.versions,
					});
					return;
				} catch {
					// json 解析失败走下方 fallback
				}
			}
			resolve({
				ok: false,
				missing: ["yt-dlp", "faster-whisper"],
				versions: {},
				error: err.trim() || `检测脚本异常退出（码 ${c}）`,
			});
		});
	});
}

/**
 * 安装或升级依赖（yt-dlp、faster-whisper）到虚拟环境。
 */
export function installDeps(
	venvPython: string,
	onLine?: (line: string) => void,
	pipIndexUrl?: string,
): Promise<{ ok: boolean; error?: string }> {
	const args = ["-m", "pip", "install", "-U", "yt-dlp", "faster-whisper"];
	if (pipIndexUrl && pipIndexUrl.trim()) {
		args.push("-i", pipIndexUrl.trim());
	}

	onLine?.("正在使用 pip 安装依赖（yt-dlp, faster-whisper）… 首次安装可能需要 1~3 分钟，请稍候。");

	return new Promise((resolve) => {
		let stderrBuffer = "";
		let child: ChildProcess;
		try {
			child = spawn(venvPython, args, { windowsHide: true });
		} catch (e) {
			resolve({ ok: false, error: `启动 pip 安装命令失败：${String(e)}` });
			return;
		}

		const handleChunk = (chunk: Buffer | string) => {
			const lines = chunk.toString().split(/\r?\n/);
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed) onLine?.(trimmed);
			}
		};

		child.stdout?.on("data", handleChunk);
		child.stderr?.on("data", (chunk) => {
			stderrBuffer += chunk.toString();
			handleChunk(chunk);
		});
		child.on("error", (e) => resolve({ ok: false, error: `pip 安装出错：${e.message}` }));
		child.on("close", (code) => {
			if (code === 0) {
				onLine?.("依赖安装完成 ✅");
				resolve({ ok: true });
			} else {
				resolve({
					ok: false,
					error: `pip 安装退出码 ${code}。\n${stderrBuffer.slice(-500)}`,
				});
			}
		});
	});
}

export interface ReadyEnvResult {
	ok: boolean;
	error?: string;
	venvPython?: string;
	ytdlpPath?: string;
	modelsDir?: string;
	binDir?: string;
}

/**
 * 一键确保虚拟环境与所有依赖准备就绪。
 * 流程：
 * 1. 检查 venv 是否存在且依赖齐备；若已就绪，立即快速返回。
 * 2. 若 venv 不存在：探测系统 Python（未找到则报错并提示安装指引）→ 创建 venv。
 * 3. 检查依赖，若缺失则自动执行 pip 安装。
 * 4. 确保模型根目录存在。
 */
export async function ensureEnvReady(options: {
	configuredPython?: string;
	pipIndexUrl?: string;
	onLine?: (line: string) => void;
}): Promise<ReadyEnvResult> {
	const paths = getVenvPaths();

	try {
		mkdirSync(paths.modelsDir, { recursive: true });
	} catch {
		// 忽略目录已存在或权限警告
	}

	// 1. 若 venv 已存在，先快速检查依赖
	if (existsSync(paths.python)) {
		const depCheck = await checkDeps(paths.python);
		if (depCheck.ok) {
			return {
				ok: true,
				venvPython: paths.python,
				ytdlpPath: paths.ytdlp,
				modelsDir: paths.modelsDir,
				binDir: paths.binDir,
			};
		}
		// 依赖缺失，执行安装
		options.onLine?.(`检测到缺少依赖：${depCheck.missing.join(", ")}，开始自动安装…`);
		const installRes = await installDeps(paths.python, options.onLine, options.pipIndexUrl);
		if (!installRes.ok) {
			return { ok: false, error: `依赖安装失败：${installRes.error}` };
		}
		return {
			ok: true,
			venvPython: paths.python,
			ytdlpPath: paths.ytdlp,
			modelsDir: paths.modelsDir,
			binDir: paths.binDir,
		};
	}

	// 2. venv 尚未创建，探测系统 Python
	options.onLine?.("正在探测系统 Python 解释器…");
	const pyDetect = await detectSystemPython(options.configuredPython);
	if (!pyDetect.ok || !pyDetect.path) {
		const err = pyDetect.installHelp || pyDetect.error || "未找到可用的 Python 3.9+。";
		return { ok: false, error: err };
	}

	options.onLine?.(`找到系统 Python：${pyDetect.path} (${pyDetect.version})`);

	// 3. 创建虚拟环境
	const venvRes = await ensureVenv(pyDetect.path, options.onLine);
	if (!venvRes.ok) {
		return { ok: false, error: venvRes.error };
	}

	// 4. 安装依赖
	const installRes = await installDeps(paths.python, options.onLine, options.pipIndexUrl);
	if (!installRes.ok) {
		return { ok: false, error: `依赖安装失败：${installRes.error}` };
	}

	return {
		ok: true,
		venvPython: paths.python,
		ytdlpPath: paths.ytdlp,
		modelsDir: paths.modelsDir,
		binDir: paths.binDir,
	};
}

export interface DoctorReport {
	allOk: boolean;
	scriptOk: boolean;
	scriptPath: string;
	systemPythonOk: boolean;
	systemPythonPath?: string;
	systemPythonVersion?: string;
	venvOk: boolean;
	venvPath: string;
	ytdlpOk: boolean;
	ytdlpVersion?: string;
	whisperOk: boolean;
	whisperVersion?: string;
	modelsDirOk: boolean;
	modelsDirPath: string;
	scriptDoctorOutput?: string;
	summary: string;
}

/**
 * 结构化完整环境诊断（供设置页与面板使用）。
 */
export async function runEnvDoctor(
	scriptPath: string | null,
	configuredPython?: string,
): Promise<DoctorReport> {
	const paths = getVenvPaths();
	const scriptExists = !!(scriptPath && existsSync(scriptPath));

	const sysPy = await detectSystemPython(configuredPython);
	const venvExists = existsSync(paths.python);
	const deps = venvExists ? await checkDeps(paths.python) : { ok: false, missing: ["yt-dlp", "faster-whisper"], versions: {} };

	let modelsDirOk = false;
	try {
		mkdirSync(paths.modelsDir, { recursive: true });
		modelsDirOk = true;
	} catch {
		modelsDirOk = false;
	}

	let scriptDoctorOutput = "";
	if (scriptExists && venvExists && deps.ok) {
		scriptDoctorOutput = await new Promise<string>((resolve) => {
			let out = "";
			try {
				const child = spawn(paths.python, [scriptPath!, "--doctor"], {
					env: {
						...process.env,
						YT_DLP_PATH: paths.ytdlp,
						PODCAST_ASR_MODEL_ROOT: paths.modelsDir,
						PATH: `${paths.binDir}${isWin ? ";" : ":"}${process.env.PATH || ""}`,
					},
					windowsHide: true,
				});
				child.stdout?.on("data", (d) => (out += d.toString()));
				child.stderr?.on("data", (d) => (out += d.toString()));
				child.on("close", () => resolve(out.trim()));
				child.on("error", (e) => resolve(`执行 --doctor 失败：${e.message}`));
			} catch (e) {
				resolve(String(e));
			}
		});
	}

	const allOk = scriptExists && venvExists && deps.ok && modelsDirOk;
	const lines: string[] = [];
	lines.push(`转写脚本: ${scriptExists ? "OK ✅ (" + scriptPath + ")" : "FAIL ❌ 未找到脚本"}`);
	lines.push(
		`系统 Python: ${sysPy.ok ? "OK ✅ (" + sysPy.path + " " + sysPy.version + ")" : "FAIL ❌ " + (sysPy.error || "未找到")}`,
	);
	lines.push(`隔离虚拟环境: ${venvExists ? "OK ✅ (" + paths.venvDir + ")" : "FAIL ❌ 未创建"}`);
	lines.push(
		`yt-dlp: ${!deps.missing.includes("yt-dlp") ? "OK ✅ (" + (deps.versions["yt-dlp"] || "已安装") + ")" : "FAIL ❌ 未安装"}`,
	);
	lines.push(
		`faster-whisper: ${!deps.missing.includes("faster-whisper") ? "OK ✅ (" + (deps.versions["faster-whisper"] || "已安装") + ")" : "FAIL ❌ 未安装"}`,
	);
	lines.push(`模型目录: ${modelsDirOk ? "OK ✅ (" + paths.modelsDir + ")" : "FAIL ❌ 不可写"}`);

	return {
		allOk,
		scriptOk: scriptExists,
		scriptPath: scriptPath || "",
		systemPythonOk: sysPy.ok,
		systemPythonPath: sysPy.path,
		systemPythonVersion: sysPy.version,
		venvOk: venvExists,
		venvPath: paths.venvDir,
		ytdlpOk: !deps.missing.includes("yt-dlp"),
		ytdlpVersion: deps.versions["yt-dlp"],
		whisperOk: !deps.missing.includes("faster-whisper"),
		whisperVersion: deps.versions["faster-whisper"],
		modelsDirOk,
		modelsDirPath: paths.modelsDir,
		scriptDoctorOutput,
		summary: lines.join("\n"),
	};
}
