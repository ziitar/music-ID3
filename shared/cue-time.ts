const FRAMES_PER_SECOND = 75;
const SECONDS_PER_MINUTE = 60;

export function framesToCueTime(frames: number): string {
  if (!Number.isInteger(frames) || frames < 0) {
    throw new RangeError("CUE frames must be a non-negative integer");
  }

  const minutes = Math.floor(frames / (FRAMES_PER_SECOND * SECONDS_PER_MINUTE));
  const seconds = Math.floor(frames / FRAMES_PER_SECOND) % SECONDS_PER_MINUTE;
  const remainingFrames = frames % FRAMES_PER_SECOND;
  return [minutes, seconds, remainingFrames].map((value) => String(value).padStart(2, "0")).join(":");
}
