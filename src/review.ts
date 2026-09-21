export function transcriptLine(line: string): {start:number;end:number;text:string} | null {
  const match = /^\[track \d+ · (\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?) → (\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)\] (.*)$/.exec(line);
  if (!match) return null;
  const start = Number(match[1])*3600+Number(match[2])*60+Number(match[3]);
  const end = Number(match[4])*3600+Number(match[5])*60+Number(match[6]);
  if (end < start || [match[2],match[3],match[5],match[6]].some(v=>Number(v)>=60)) return null;
  return {start,end,text:match[7]};
}

export function suggestedMatterName(names: string[]): string | null {
  const matches = names.flatMap(name=>{
    const match = /^(.+?)\s+-\s+(\d{2}[A-Z]{2,5}\d{3,})\.pdf$/i.exec(name);
    return match ? [`${match[1].trim()} · ${match[2].toUpperCase()}`] : [];
  });
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

export type TranscriptTiming = { container_origin_seconds?: number; tracks?: { index: number; origin_seconds: number }[] };
// Track-relative transcript -> container-relative playback. Missing legacy metadata is not zero.
export function transcriptPlaybackLine(line: string, metadata?: TranscriptTiming): {start:number;end:number;text:string} | null {
  const interval = transcriptLine(line);
  const track = /^\[track (\d+) ·/.exec(line);
  const origin = metadata?.tracks?.find(t => t.index === Number(track?.[1]))?.origin_seconds;
  const container = metadata?.container_origin_seconds;
  if (!interval || !track || origin === undefined || container === undefined || !Number.isFinite(origin) || !Number.isFinite(container)) return null;
  const start = interval.start + origin - container;
  const end = interval.end + origin - container;
  return start >= 0 && end >= start ? { ...interval, start, end } : null;
}
export type ClockMapping = { scale: number; offset_seconds: number; valid_source_range: [number,number]; uncertainty_seconds: number };
export function incidentToSource(incident: number, mapping: ClockMapping): {seconds:number;uncertainty:number} | null {
  if (![incident,mapping.scale,mapping.offset_seconds,mapping.uncertainty_seconds,...mapping.valid_source_range].every(Number.isFinite) || mapping.scale <= 0 || mapping.uncertainty_seconds < 0) return null;
  const seconds = (incident - mapping.offset_seconds) / mapping.scale;
  if (seconds < mapping.valid_source_range[0] || seconds > mapping.valid_source_range[1]) return null;
  return {seconds, uncertainty: mapping.uncertainty_seconds / mapping.scale};
}
