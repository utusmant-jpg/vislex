// A readable chat title from the first question when no title was saved.
// Local and deterministic: nothing is sent anywhere to name a chat.
const filler = /^(?:please\s+|kindly\s+|hey[,!]?\s+|hi[,!]?\s+|can you\s+|could you\s+|would you\s+|will you\s+|i want you to\s+|i need you to\s+|i'd like you to\s+|help me\s+)+/i;

export function deriveTitle(prompt: string, limit = 52): string {
  let text = prompt.replace(/\s+/g, ' ').trim();
  if (!text) return 'New chat';
  const stripped = text.replace(filler, '');
  if (stripped) text = stripped;
  // First sentence only; keep its closing question mark.
  const sentence = /^(.+?[.?!])(?:\s|$)/.exec(text);
  if (sentence && sentence[1].length >= 12) text = sentence[1];
  text = text.replace(/\.$/, '');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (text.length > limit) {
    const cut = text.slice(0, limit);
    const space = cut.lastIndexOf(' ');
    text = `${(space > limit * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, '')}…`;
  }
  return text;
}
