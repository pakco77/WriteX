import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectImage } from "./images.ts";

export interface GifOptimizationProfile {
  fps: number;
  width: number;
  colors: number;
  dither: number;
}

export interface GifOptimizationResult {
  bytes: ArrayBuffer;
  profile: GifOptimizationProfile;
  frameCount: number;
  frameRate?: number;
  durationSeconds?: number;
}

export function gifOptimizationProfiles(
  source: { width?: number; frameRate?: number },
  targetBytes: number,
): GifOptimizationProfile[] {
  const width = Math.max(320, Math.min(960, source.width ?? 960));
  const targetMb = targetBytes / 1024 / 1024;
  const firstColors = targetMb < 5 ? 112 : 128;
  return [
    { fps: Math.min(15, Math.max(12, Math.round(source.frameRate ?? 15))), width, colors: firstColors, dither: 3 },
    { fps: 12, width: Math.min(800, width), colors: 96, dither: 4 },
    { fps: 12, width: Math.min(640, width), colors: 80, dither: 5 },
    { fps: 10, width: Math.min(540, width), colors: 64, dither: 5 },
  ];
}

export function gifVideoFilter(profile: GifOptimizationProfile): string {
  return `${[
    `fps=${profile.fps}`,
    `scale='min(${profile.width},iw)':-2:flags=lanczos`,
    "split[frames][palette_input]",
  ].join(",")};[palette_input]palettegen=max_colors=${profile.colors}:stats_mode=diff[palette];[frames][palette]paletteuse=dither=bayer:bayer_scale=${profile.dither}:diff_mode=rectangle`;
}

async function runFfmpeg(inputPath: string, outputPath: string, profile: GifOptimizationProfile, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", inputPath,
      "-filter_complex", gifVideoFilter(profile),
      "-loop", "0",
      outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new DOMException("GIF 优化已取消", "AbortError"));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg 优化 GIF 失败${stderr ? `：${stderr.trim()}` : "。"}`));
    });
  });
}

export async function optimizeAnimatedGif(
  inputPath: string,
  source: { width?: number; frameRate?: number; durationSeconds?: number },
  targetBytes: number,
  signal: AbortSignal,
  onProfile: (profile: GifOptimizationProfile, index: number, total: number) => void = () => undefined,
): Promise<GifOptimizationResult> {
  const directory = await mkdtemp(join(tmpdir(), "write-gif-"));
  const output = join(directory, "optimized.gif");
  const profiles = gifOptimizationProfiles(source, targetBytes);
  let lastSize = 0;
  try {
    for (let index = 0; index < profiles.length; index += 1) {
      const profile = profiles[index];
      onProfile(profile, index + 1, profiles.length);
      await runFfmpeg(inputPath, output, profile, signal);
      const file = await readFile(output);
      lastSize = file.byteLength;
      const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
      const inspection = inspectImage(bytes, { fileName: "optimized.gif", declaredMime: "image/gif" });
      const durationDifference = source.durationSeconds && inspection.durationSeconds
        ? Math.abs(source.durationSeconds - inspection.durationSeconds)
        : 0;
      if (
        inspection.complete
        && inspection.animated
        && file.byteLength < targetBytes
        && durationDifference <= Math.max(0.25, 1 / profile.fps + 0.05)
      ) {
        return {
          bytes,
          profile,
          frameCount: inspection.frameCount ?? 0,
          frameRate: inspection.frameRate,
          durationSeconds: inspection.durationSeconds,
        };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("未找到 ffmpeg。请先安装 ffmpeg，或选择 Relay / 只复制文字。", { cause: error });
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  throw new Error(`GIF 优化后仍为 ${(lastSize / 1024 / 1024).toFixed(2)} MB，未达到目标；未伪装为成功。`);
}
