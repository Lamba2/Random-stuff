const MAX_MESSAGES = 1000;
const KEEP_OLDEST = 100;

const oldestId = ids => ids.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));

// Newest-first pages of 100 until we run out or hit the cap, returned oldest-first. If the channel is
// longer than the cap, the first 100 messages are kept too, so the original request is never lost.
async function fetchHistory(channel, max = MAX_MESSAGES) {
  const keepOldest = Math.min(KEEP_OLDEST, Math.floor(max / 2));
  const newest = [];
  let before;
  let truncated = false;
  while (true) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;
    newest.push(...page.values());
    before = oldestId([...page.keys()]);
    if (page.size < 100) break;
    if (newest.length >= max - keepOldest) {
      truncated = true;
      break;
    }
  }
  let messages = newest.slice(0, truncated ? max - keepOldest : max);
  if (truncated && keepOldest > 0) {
    const first = await channel.messages.fetch({ limit: keepOldest, after: '0' });
    const seen = new Set(messages.map(m => m.id));
    const extra = [...first.values()].filter(m => !seen.has(m.id));
    if (extra.length) {
      // the message just before the newest block tells us whether anything sits between the two blocks
      const probe = (await channel.messages.fetch({ limit: 1, before: oldestId([...seen]) })).first();
      truncated = Boolean(probe && !first.has(probe.id));
    } else {
      truncated = false;
    }
    messages = messages.concat(extra);
  }
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return { messages, truncated };
}

const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

function formatTranscript(messages, { guildName, channelName, title, truncated = false }) {
  const lines = [
    title,
    `Server: ${guildName}`,
    `Channel: #${channelName}`,
    `Messages: ${messages.length}`,
    `Saved: ${stamp(Date.now())}`,
  ];
  if (truncated) lines.push('NOTE: this ticket was very long. The first and the most recent messages are included; some in between were left out.');
  lines.push('-'.repeat(60));
  let hidden = 0;
  for (const m of messages) {
    const who = m.author ? `${m.author.tag}${m.author.bot ? ' [bot]' : ''}` : 'unknown';
    const parts = [];
    if (m.content) parts.push(m.content);
    for (const e of m.embeds || []) {
      const text = [e.title, e.description].filter(Boolean).join(' - ');
      if (text) parts.push(`[embed] ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    for (const a of m.attachments ? m.attachments.values() : []) parts.push(`[attachment] ${a.name} ${a.url}`);
    if (!parts.length) {
      hidden++;
      parts.push('(no visible content)');
    }
    lines.push(`[${stamp(m.createdTimestamp)}] ${who}: ${parts.join('\n    ')}`);
  }
  if (hidden) {
    lines.push('-'.repeat(60));
    lines.push(`${hidden} message(s) had no visible content. If that's most of them, turn on "Message Content Intent"`);
    lines.push('for this bot in the Discord Developer Portal (Bot tab) so transcripts include message text.');
  }
  return lines.join('\n') + '\n';
}

async function buildTranscript(channel, title) {
  const { messages, truncated } = await fetchHistory(channel);
  const text = formatTranscript(messages, { guildName: channel.guild.name, channelName: channel.name, title, truncated });
  return { text, count: messages.length, truncated };
}

module.exports = { fetchHistory, formatTranscript, buildTranscript, MAX_MESSAGES };
