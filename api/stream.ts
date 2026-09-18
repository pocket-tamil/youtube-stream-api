import { Innertube, UniversalCache, Parser } from "youtubei.js";

// Suppress benign internal JIT parser warnings from Innertube
Parser.setParserErrorHandler(() => {});

export const config = {
  maxDuration: 30,
};

type RequestQuery = {
  url?: string;
  channel?: string;
};

let youtubeClient: Innertube | null = null;

/**
 * Reuse the YouTube client between warm Vercel invocations.
 */
async function getYouTubeClient(): Promise<Innertube> {
  if (!youtubeClient) {
    youtubeClient = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
    });
  }

  return youtubeClient;
}

/**
 * Extract a YouTube video ID from common YouTube URLs.
 */
function extractVideoId(input: string): string | null {
  input = input.trim();

  // Plain video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  try {
    const url = new URL(input);

    // https://www.youtube.com/watch?v=VIDEO_ID
    if (
      (url.hostname === "youtube.com" ||
        url.hostname === "www.youtube.com" ||
        url.hostname === "m.youtube.com") &&
      url.pathname === "/watch"
    ) {
      return url.searchParams.get("v");
    }

    // https://youtu.be/VIDEO_ID
    if (url.hostname === "youtu.be") {
      return url.pathname.substring(1).split("/")[0] || null;
    }

    // https://www.youtube.com/live/VIDEO_ID
    if (
      (url.hostname === "youtube.com" ||
        url.hostname === "www.youtube.com") &&
      url.pathname.startsWith("/live/")
    ) {
      return url.pathname.split("/")[2] || null;
    }

    // https://www.youtube.com/embed/VIDEO_ID
    if (
      (url.hostname === "youtube.com" ||
        url.hostname === "www.youtube.com") &&
      url.pathname.startsWith("/embed/")
    ) {
      return url.pathname.split("/")[2] || null;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Extract a channel ID from:
 *
 * UCxxxxxxxxxxxxxxxxxxxxxx
 * https://youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx
 */
function extractChannelId(input: string): string | null {
  input = input.trim();

  if (/^UC[a-zA-Z0-9_-]{20,}$/.test(input)) {
    return input;
  }

  try {
    const url = new URL(input);

    if (
      (url.hostname === "youtube.com" ||
        url.hostname === "www.youtube.com") &&
      url.pathname.startsWith("/channel/")
    ) {
      const id = url.pathname.split("/")[2];

      if (id && /^UC[a-zA-Z0-9_-]{20,}$/.test(id)) {
        return id;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Find a currently live video on a channel.
 *
 * YouTube's channel response can change shape, so this handles
 * both older Video nodes and newer content_id-based nodes.
 */
async function findLiveVideoOnChannel(
  yt: Innertube,
  channelId: string
): Promise<string | null> {
  const channel = await yt.getChannel(channelId);

  // Prefer the channel's Live tab if available.
  try {
    const tabs = channel.tabs || [];

    const liveTab: any = tabs.find((tab: any) => {
      const title =
        tab?.title?.toString?.()?.toLowerCase?.() ||
        tab?.tab_title?.toString?.()?.toLowerCase?.() ||
        "";

      return title === "live" || title.includes("live");
    });

    if (liveTab?.endpoint) {
      const livePage: any = await liveTab.endpoint.call(yt.actions);

      const items: any[] = [
        ...(livePage?.videos || []),
        ...(livePage?.contents || []),
      ];

      for (const item of items) {
        const videoId =
          item?.id ||
          item?.video_id ||
          item?.content_id ||
          item?.videoId;

        if (videoId) {
          const info = await yt.getInfo(videoId);

          if (info?.basic_info?.is_live === true) {
            return videoId;
          }
        }
      }
    }
  } catch {
    // Fall through to the videos tab.
  }

  /**
   * Fallback: inspect recent channel videos.
   *
   * youtubei.js channel responses have changed over time;
   * newer responses can expose LockupView.content_id instead
   * of Video.video_id.
   */
  try {
    const videosPage: any = await channel.getVideos();

    const videos: any[] = videosPage?.videos || [];

    for (const video of videos) {
      const videoId =
        video?.id ||
        video?.video_id ||
        video?.content_id;

      if (!videoId) {
        continue;
      }

      try {
        const info = await yt.getInfo(videoId);

        if (info?.basic_info?.is_live === true) {
          return videoId;
        }
      } catch {
        // Ignore an individual unavailable video.
      }
    }
  } catch {
    // No videos available.
  }

  return null;
}

/**
 * Get the HLS manifest URL for a YouTube video.
 */
async function getHlsManifest(videoId: string): Promise<{ hlsUrl: string; title: string }> {
  const yt = await getYouTubeClient();

  // YouTube desktop WEB client no longer provides HLS (.m3u8) manifests directly;
  // mobile clients (ANDROID / MWEB) provide the valid .m3u8 HLS playlist.
  let info: any = null;
  try {
    info = await yt.getInfo(videoId, { client: "ANDROID" });
  } catch {
    // Fallback if ANDROID client errors
  }

  if (!info || !info.streaming_data?.hls_manifest_url) {
    try {
      info = await yt.getInfo(videoId, { client: "MWEB" });
    } catch {
      // Fallback
    }
  }

  if (!info || !info.streaming_data?.hls_manifest_url) {
    info = await yt.getInfo(videoId);
  }

  if (!info) {
    throw new Error("Unable to retrieve YouTube video information");
  }

  const basicInfo: any = info.basic_info || {};

  const isLive =
    basicInfo.is_live === true ||
    basicInfo.isLive === true;

  if (!isLive) {
    throw new Error("The supplied video is not currently live");
  }

  const streamingData: any = info.streaming_data;

  if (!streamingData) {
    throw new Error("YouTube did not return streaming data");
  }

  const hlsUrl =
    streamingData.hls_manifest_url ||
    streamingData.hlsManifestUrl;

  if (!hlsUrl) {
    throw new Error(
      "No HLS .m3u8 manifest was returned by YouTube"
    );
  }

  return { hlsUrl, title: basicInfo.title || "" };
}

/**
 * Vercel Serverless Function
 *
 * GET /api/stream?url=https://www.youtube.com/watch?v=VIDEO_ID
 *
 * or
 *
 * GET /api/stream?url=UC_CHANNEL_ID
 */
export default async function handler(
  req: any,
  res: any
): Promise<void> {
  // Set CORS headers so web players can access this endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Only GET and HEAD are supported
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");

    res.status(405).json({
      error: "Method not allowed",
    });

    return;
  }

  const query: RequestQuery = req.query || {};

  const input =
    query.url ||
    query.channel;

  if (!input) {
    res.status(400).json({
      error: "Missing YouTube URL or Channel ID",
      usage:
        "/api/stream?url=https://www.youtube.com/watch?v=VIDEO_ID",
    });

    return;
  }

  try {
    let videoId = extractVideoId(input);

    // If input is a channel ID / channel URL,
    // locate its currently live video.
    if (!videoId) {
      const channelId = extractChannelId(input);

      if (!channelId) {
        res.status(400).json({
          error: "Invalid YouTube video URL or channel ID",
        });

        return;
      }

      const yt = await getYouTubeClient();

      videoId = await findLiveVideoOnChannel(
        yt,
        channelId
      );

      if (!videoId) {
        res.status(404).json({
          error: "No currently live video found on this channel",
        });

        return;
      }
    }

    const { hlsUrl, title } = await getHlsManifest(videoId);

    // If JSON format is requested via query param (e.g. ?format=json or ?redirect=false)
    if (
      (query as any).format === "json" ||
      (query as any).json === "true" ||
      (query as any).redirect === "false"
    ) {
      res.status(200).json({
        videoId,
        title,
        hlsUrl,
      });
      return;
    }

    // Required 302 redirect.
    res.statusCode = 302;

    res.setHeader("Location", hlsUrl);

    // Cache the location for 10 minutes.
    res.setHeader(
      "Cache-Control",
      "public, max-age=600, s-maxage=600"
    );

    res.end();
  } catch (error: any) {
    console.error("YouTube extraction error:", error);

    res.status(502).json({
      error: "Unable to extract live YouTube stream",
      message:
        error?.message || "Unknown extraction error",
    });
  }
}