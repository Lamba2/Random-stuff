const MAX_MESSAGES = 1000;

// Newest-first pages of 100 until we run out or hit the cap, returned oldest-first.
async function fetchHistory(channel, max = MAX_MESSAGES) {
  const all = [];
  let before;
  while (all.length < max) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;
    all.push(...page.values());
    before = [...page.keys()].reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
    if (page.size < 100) break;
  }
  return all.slice(0, max).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

function formatTranscript(messages, { guildName, channelName, title }) {
  const lines = [
    title,
    `Server: ${guildName}`,
    `Channel: #${channelName}`,
    `Messages: ${messages.length}`,
    `Saved: ${stamp(Date.now())}`,
    '-'.repeat(60),
  ];
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
  const messages = await fetchHistory(channel);
  const text = formatTranscript(messages, { guildName: channel.guild.name, channelName: channel.name, title });
  return { text, count: messages.length };
}

module.exports = { fetchHistory, formatTranscript, buildTranscript, MAX_MESSAGES };
