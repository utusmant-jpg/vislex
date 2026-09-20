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
