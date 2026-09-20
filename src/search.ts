import { requestUrl } from "obsidian";

export interface PodcastResult {
	collectionId: number;
	name: string;
	author: string;
	artwork: string;
	feedUrl: string;
}

export interface EpisodeResult {
	title: string;
	podcast: string;
	audioUrl: string;
	date: string;
	artwork: string;
	description?: string;
	duration?: number; // 持续时间（秒）
	outline?: string[]; // 核心看点大纲列表
	source?: "scripod" | "itunes";
}

interface ITunesRow {
	wrapperType?: string;
	collectionId?: number;
	collectionName?: string;
	artistName?: string;
	trackName?: string;
	episodeUrl?: string;
	releaseDate?: string;
	feedUrl?: string;
	artworkUrl60?: string;
	artworkUrl100?: string;
	description?: string;
	shortDescription?: string;
	trackTimeMillis?: number;
}

async function itunes(url: string): Promise<ITunesRow[]> {
	const res = await requestUrl({ url });
	const json = res.json as { results?: ITunesRow[] } | undefined;
	return json?.results ?? [];
}

function toEpisode(r: ITunesRow): EpisodeResult {
	const rawDesc = r.description || r.shortDescription || "";
	// 简易去除可能存在的 HTML 标签
	const cleanDesc = rawDesc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	const durationSec = r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined;
	return {
		title: (r.trackName ?? "").trim(),
		podcast: (r.collectionName ?? "").trim(),
		audioUrl: r.episodeUrl ?? "",
		date: (r.releaseDate ?? "").slice(0, 10),
		artwork: r.artworkUrl60 ?? r.artworkUrl100 ?? "",
		description: cleanDesc,
		duration: durationSec,
		source: "itunes",
	};
}

export async function searchPodcasts(term: string, limit = 6): Promise<PodcastResult[]> {
	const url = `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=${limit}&term=${encodeURIComponent(term)}`;
	const rows = await itunes(url);
	return rows
		.filter((r) => r.collectionId)
		.map((r) => ({
			collectionId: r.collectionId as number,
			name: (r.collectionName ?? "").trim(),
			author: (r.artistName ?? "").trim(),
			artwork: r.artworkUrl100 ?? r.artworkUrl60 ?? "",
			feedUrl: r.feedUrl ?? "",
		}));
}

export async function searchEpisodes(term: string, limit = 10): Promise<EpisodeResult[]> {
	const url = `https://itunes.apple.com/search?media=podcast&entity=podcastEpisode&limit=${limit}&term=${encodeURIComponent(term)}`;
	const rows = await itunes(url);
	return rows.filter((r) => r.episodeUrl).map(toEpisode);
}

export async function lookupEpisodes(collectionId: number, limit = 30): Promise<EpisodeResult[]> {
	const url = `https://itunes.apple.com/lookup?id=${collectionId}&media=podcast&entity=podcastEpisode&limit=${limit}`;
	const rows = await itunes(url);
	return rows.filter((r) => r.wrapperType === "podcastEpisode" && r.episodeUrl).map(toEpisode);
}
