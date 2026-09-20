// 让 TypeScript 认识「把 .py 文件作为文本导入」的写法。
// 构建时由 esbuild 的 text loader 把脚本内容内联成字符串。
declare module "*.py" {
	const content: string;
	export default content;
}
