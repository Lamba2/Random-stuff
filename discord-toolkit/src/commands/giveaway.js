const {
  SlashCommandBuilder, InteractionContextType, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, MessageFlags, RESTJSONErrorCodes, PermissionFlagsBits: P,
} = require('discord.js');
const { ephemeral, isAdmin, botMember, cantPost } = require('../lib/util');

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const MIN_DURATION = 10 * SECOND;
const MAX_DURATION = 30 * DAY;
const MAX_TIMER = 2 ** 31 - 1; // setTimeout fires immediately for anything longer
const EDIT_EVERY = 5 * SECOND;
const DOUBLE_CLICK = 1500;
const RETRY_AFTER = 60 * SECOND;
const KEEP_ENDED = 30 * DAY;
const GREY = 0x99aab5;
// Threads auto-archive and drop out of the cache on restart, and voice chats aren't giveaway channels.
const POSTABLE = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const data = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Run giveaways with a Join button')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(s => s
    .setName('start')
    .setDescription('Start a giveaway (Manage Server)')
    .addStringOption(o => o.setName('prize').setDescription('What the winners get').setRequired(true).setMaxLength(200))
    .addStringOption(o => o.setName('duration').setDescription('How long it runs, e.g. 30m, 2h, 1d or 1h30m (10s to 30d)').setRequired(true).setMaxLength(30))
    .addIntegerOption(o => o.setName('winners').setDescription('How many winners (default 1)').setMinValue(1).setMaxValue(20))
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (default: this channel)').addChannelTypes(...POSTABLE))
    .addRoleOption(o => o.setName('required_role').setDescription('Only members with this role can enter')))
  .addSubcommand(s => s
    .setName('end')
    .setDescription('End a giveaway now and draw the winners (Manage Server)')
    .addStringOption(o => o.setName('message_id').setDescription('ID or link of the giveaway message').setRequired(true).setMaxLength(200)))
  .addSubcommand(s => s
    .setName('reroll')
    .setDescription('Draw new winners for an ended giveaway (Manage Server)')
    .addStringOption(o => o.setName('message_id').setDescription('ID or link of the giveaway message').setRequired(true).setMaxLength(200))
    .addIntegerOption(o => o.setName('winners').setDescription('How many new winners (default 1)').setMinValue(1).setMaxValue(20)))
  .addSubcommand(s => s.setName('list').setDescription('Show the giveaways that are running'))
  .addSubcommand(s => s
    .setName('cancel')
    .setDescription('Stop a giveaway without drawing winners (Manage Server)')
    .addStringOption(o => o.setName('message_id').setDescription('ID or link of the giveaway message').setRequired(true).setMaxLength(200)));

const UNITS = {
  s: SECOND, sec: SECOND, secs: SECOND, second: SECOND, seconds: SECOND,
  m: 60 * SECOND, min: 60 * SECOND, mins: 60 * SECOND, minute: 60 * SECOND, minutes: 60 * SECOND,
  h: 3600 * SECOND, hr: 3600 * SECOND, hrs: 3600 * SECOND, hour: 3600 * SECOND, hours: 3600 * SECOND,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, wk: 7 * DAY, wks: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY,
};

// "1h30m", "2 days", "1w 2d" -> milliseconds, or null if it isn't a duration.
function parseDuration(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  const part = /[\s,]*(\d+(?:\.\d+)?)\s*([a-z]+)[\s,]*/y;
  let total = 0;
  while (part.lastIndex < s.length) {
    const m = part.exec(s);
    if (!m || !UNITS[m[2]]) return null;
    total += Number(m[1]) * UNITS[m[2]];
  }
  return Number.isFinite(total) ? Math.round(total) : null;
}

const now = ctx => ctx.now?.() ?? Date.now();
const setTimer = ctx => ctx.setTimer ?? setTimeout;
const clearTimer = ctx => ctx.clearTimer ?? clearTimeout;
const unix = ms => Math.floor(ms / 1000);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const link = (guildId, gw) => `https://discord.com/channels/${guildId}/${gw.channelId}/${gw.messageId}`;

function section(ctx, guildId) {
  const g = ctx.store.guild(guildId);
  if (!g.giveaways || typeof g.giveaways !== 'object') g.giveaways = { byMessage: {} };
  g.giveaways.byMessage ??= {};
  return g.giveaways;
}

const find = (ctx, guildId, messageId) => section(ctx, guildId).byMessage[messageId] ?? null;

function prune(sec, t) {
  for (const [id, gw] of Object.entries(sec.byMessage)) {
    if (gw?.status !== 'running' && t - (gw?.endedAt ?? 0) > KEEP_ENDED) delete sec.byMessage[id];
  }
}

// In-memory coordination. The store says what happened; these stop two things happening at once.
const busy = new Set(); // giveaways whose winners are being drawn right now
const endTimers = new Map(); // messageId -> timer handle
const countEdits = new Map(); // messageId -> { last, timer }
const recentClicks = new Map(); // `${messageId}:${userId}` -> time of their last toggle
const queues = new Map(); // messageId -> tail of that message's edit queue

// Runs edits to one message in order, so a slow entry-count edit can't land after the "Ended" edit.
function serial(key, task) {
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.then(() => {}, () => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

function mentionList(ids, budget = 1500) {
  let out = '';
  for (let i = 0; i < ids.length; i++) {
    const next = `${out ? ', ' : ''}<@${ids[i]}>`;
    if (out.length + next.length > budget) return `${out} …and ${ids.length - i} more`;
    out += next;
  }
  return out;
}

const lines = (...parts) => parts.filter(p => typeof p === 'string').join('\n');

function joinRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('giveaway:join').setLabel('Join').setEmoji('🎉').setStyle(ButtonStyle.Primary));
}

function giveawayMessage(gw, color) {
  const embed = new EmbedBuilder().setTitle(`🎉 ${gw.prize}`.slice(0, 256));
  const host = `**Hosted by:** <@${gw.hostId}>`;
  const role = gw.requiredRoleId ? `**Required role:** <@&${gw.requiredRoleId}>` : null;
  const entries = `**Entries:** ${gw.entrants.length}`;
  if (gw.status === 'running') {
    const t = unix(gw.endsAt);
    embed.setColor(color).setDescription(lines(
      'Press **Join** to enter. Press it again to leave.', '',
      `**Ends:** <t:${t}:R> (<t:${t}:f>)`, `**Winners:** ${gw.winnerCount}`, host, role, entries));
    return { embeds: [embed], components: [joinRow()] };
  }
  embed.setColor(GREY).setTimestamp(gw.endedAt);
  if (gw.status === 'cancelled') {
    embed.setDescription(lines('**This giveaway was cancelled.**', '', host, role, entries)).setFooter({ text: 'Cancelled' });
    return { embeds: [embed], components: [] };
  }
  embed.setDescription(lines(
    '**This giveaway has ended.**', '',
    `**Winners:** ${gw.winners.length ? mentionList(gw.winners) : 'no valid entries'}`,
    gw.rerolled.length ? `**Rerolled:** ${mentionList(gw.rerolled)}` : null,
    host, role, entries)).setFooter({ text: 'Ended' });
  return { embeds: [embed], components: [] };
}

// ---------- drawing winners ----------

function* shuffled(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i >= 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
    yield a[i];
  }
}

// The bot only has the Guilds intent, so cached members never learn that someone left or lost a role:
// ask Discord directly, and only fall back to the cache when that request fails.
async function eligible(guild, gw, userId) {
  let member;
  try {
    member = await guild.members.fetch({ user: userId, force: true });
  } catch (err) {
    if (err.code === RESTJSONErrorCodes.UnknownMember || err.code === RESTJSONErrorCodes.UnknownUser) return false;
    member = guild.members.cache?.get(userId);
    if (!member) return true; // can't check right now; an API hiccup shouldn't cost them the win
  }
  if (!gw.requiredRoleId || !guild.roles.cache.has(gw.requiredRoleId)) return true;
  return member.roles.cache.has(gw.requiredRoleId);
}

// Uniformly random, without replacement, skipping entrants who are no longer eligible.
async function drawWinners(guild, gw, count, exclude = new Set(), rand = Math.random) {
  const order = shuffled([...new Set(gw.entrants)].filter(id => !exclude.has(id)), rand);
  const winners = [];
  while (winners.length < count) {
    const batch = [];
    for (let next = order.next(); !next.done; next = order.next()) {
      batch.push(next.value);
      if (batch.length === count - winners.length) break;
    }
    if (!batch.length) break;
    const ok = await Promise.all(batch.map(id => eligible(guild, gw, id)));
    batch.forEach((id, i) => { if (ok[i]) winners.push(id); });
  }
  return winners;
}

// ---------- timers ----------

function disarm(ctx, messageId) {
  if (endTimers.has(messageId)) clearTimer(ctx)(endTimers.get(messageId));
  endTimers.delete(messageId);
  const c = countEdits.get(messageId);
  if (c?.timer) clearTimer(ctx)(c.timer);
  countEdits.delete(messageId);
}

function arm(client, ctx, guildId, messageId, minDelay = 0) {
  if (endTimers.has(messageId)) clearTimer(ctx)(endTimers.get(messageId));
  endTimers.delete(messageId);
  const gw = find(ctx, guildId, messageId);
  if (gw?.status !== 'running') return;
  const wait = Math.max(minDelay, gw.endsAt - now(ctx), 0);
  endTimers.set(messageId, setTimer(ctx)(() => {
    endTimers.delete(messageId);
    const current = find(ctx, guildId, messageId);
    if (current?.status !== 'running') return;
    if (current.endsAt > now(ctx)) return arm(client, ctx, guildId, messageId); // long giveaways chain timers
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return; // bot was removed from the server; picked up again on the next start
    // during an outage the channel cache is empty, which finish() would read as a deleted giveaway
    if (!guild.available) return arm(client, ctx, guildId, messageId, RETRY_AFTER);
    return finish(guild, ctx, messageId).catch(err => console.error('Ending a giveaway failed:', err));
  }, Math.min(wait, MAX_TIMER)));
}

function refreshCount(guild, ctx, messageId) {
  return serial(messageId, async () => {
    const gw = find(ctx, guild.id, messageId);
    if (gw?.status !== 'running' || gw.shownEntries === gw.entrants.length) return;
    const channel = guild.channels.cache.get(gw.channelId);
    if (!channel) return;
    const shown = gw.entrants.length;
    try {
      await channel.messages.edit(messageId, giveawayMessage(gw, ctx.color));
      gw.shownEntries = shown;
      ctx.store.save();
    } catch (err) {
      if (err.code !== RESTJSONErrorCodes.UnknownMessage) console.error('Updating a giveaway entry count failed:', err.message);
    }
  });
}

// At most one entry-count edit per giveaway every few seconds; a trailing edit always shows the final count.
function queueCountEdit(guild, ctx, messageId) {
  const state = countEdits.get(messageId) ?? { last: -Infinity, timer: null };
  countEdits.set(messageId, state);
  if (state.timer) return null;
  const wait = state.last + EDIT_EVERY - now(ctx);
  if (wait <= 0) {
    state.last = now(ctx);
    return refreshCount(guild, ctx, messageId);
  }
  state.timer = setTimer(ctx)(() => {
    state.timer = null;
    state.last = now(ctx);
    return refreshCount(guild, ctx, messageId);
  }, wait);
  return null;
}

// ---------- ending ----------

function markCancelled(ctx, gw) {
  gw.status = 'cancelled';
  gw.endedAt = now(ctx);
  ctx.store.save();
}

async function postEdit(channel, messageId, payload) {
  try {
    await serial(messageId, () => channel.messages.edit(messageId, payload));
  } catch (err) {
    if (err.code !== RESTJSONErrorCodes.UnknownMessage) console.error('Editing a giveaway message failed:', err.message);
  }
}

async function announce(channel, payload) {
  try {
    await channel.send(payload);
    return true;
  } catch (err) {
    console.error('Announcing giveaway winners failed:', err.message);
    return false;
  }
}

// Draws winners and announces them. Safe to call from the timer and /giveaway end at the same time.
async function finish(guild, ctx, messageId) {
  const gw = find(ctx, guild.id, messageId);
  if (gw?.status !== 'running') return { outcome: gw?.status ?? 'missing', gw };
  if (busy.has(messageId)) return { outcome: 'busy', gw };
  busy.add(messageId);
  try {
    disarm(ctx, messageId);
    const channel = guild.channels.cache.get(gw.channelId);
    if (!channel?.isTextBased?.()) {
      markCancelled(ctx, gw);
      return { outcome: 'vanished', gw };
    }
    try {
      // force: the cached copy outlives a deletion, since the Guilds intent never hears about it
      await channel.messages.fetch({ message: messageId, force: true });
    } catch (err) {
      // whoever deleted the giveaway post most likely meant to call it off
      if (err.code === RESTJSONErrorCodes.UnknownMessage || err.code === RESTJSONErrorCodes.UnknownChannel) {
        markCancelled(ctx, gw);
        return { outcome: 'vanished', gw };
      }
      console.error('Fetching a giveaway message failed:', err.message);
    }

    const winners = await drawWinners(guild, gw, gw.winnerCount, new Set(), ctx.random);
    gw.status = 'ended';
    gw.endedAt = now(ctx);
    gw.winners = winners;
    ctx.store.save();

    await postEdit(channel, messageId, giveawayMessage(gw, ctx.color));
    const announced = await announce(channel, winners.length
      ? {
        content: `🎉 Congratulations ${mentionList(winners)}! You won **${gw.prize}**.\n${link(guild.id, gw)}`,
        allowedMentions: { users: winners },
      }
      : { content: `The giveaway for **${gw.prize}** has ended with no valid entries, so there is no winner.`, allowedMentions: { parse: [] } });
    return { outcome: 'done', gw, winners, announced };
  } finally {
    busy.delete(messageId);
    // something threw before the giveaway was settled; try again in a minute instead of leaving it stuck
    if (gw.status === 'running') arm(guild.client, ctx, guild.id, messageId, RETRY_AFTER);
  }
}

// ---------- subcommands ----------

async function start(interaction, ctx) {
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to start giveaways.');
  const raw = interaction.options.getString('duration', true);
  const duration = parseDuration(raw);
  if (duration == null) {
    return ephemeral(interaction, `I couldn't read \`${raw.replace(/`/g, "'")}\` as a duration. Try something like \`30m\`, \`2h\`, \`1d\` or \`1h30m\`.`);
  }
  if (duration < MIN_DURATION) return ephemeral(interaction, 'A giveaway has to last at least 10 seconds.');
  if (duration > MAX_DURATION) return ephemeral(interaction, 'A giveaway can last at most 30 days.');
  const prize = interaction.options.getString('prize', true).replace(/\s+/g, ' ').trim();
  if (!prize) return ephemeral(interaction, 'Tell me what the prize is.');
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  if (!POSTABLE.includes(channel?.type)) return ephemeral(interaction, 'Pick a text channel with the `channel` option.');
  // otherwise Manage Server would let someone post through the bot where they can't post themselves
  if (!channel.permissionsFor(interaction.member)?.has([P.ViewChannel, P.SendMessages])) {
    return ephemeral(interaction, `You can only start giveaways in channels where you can send messages yourself, and ${channel} isn't one.`);
  }
  const role = interaction.options.getRole('required_role');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const problem = cantPost(channel, await botMember(interaction.guild), { history: true });
  if (problem) return ephemeral(interaction, problem);

  const sec = section(ctx, interaction.guildId);
  prune(sec, now(ctx));
  const gw = {
    messageId: null,
    channelId: channel.id,
    prize,
    winnerCount: interaction.options.getInteger('winners') ?? 1,
    hostId: interaction.user.id,
    requiredRoleId: role && role.id !== interaction.guildId ? role.id : null,
    endsAt: now(ctx) + duration,
    status: 'running',
    entrants: [],
    shownEntries: 0,
    winners: [],
    rerolled: [],
    endedAt: null,
  };
  const message = await channel.send(giveawayMessage(gw, ctx.color));
  gw.messageId = message.id;
  sec.byMessage[message.id] = gw;
  ctx.store.save();
  arm(interaction.client, ctx, interaction.guildId, message.id);
  return ephemeral(interaction, `Giveaway for **${prize}** started in ${channel}. It ends <t:${unix(gw.endsAt)}:R>.\nMessage ID: \`${message.id}\` (for \`/giveaway end\`, \`reroll\` or \`cancel\`).`);
}

// Accepts a bare ID or a message link, and only finds giveaways in this server.
function lookup(interaction, ctx) {
  const raw = interaction.options.getString('message_id', true).trim();
  const id = /^(?:https?:\/\/\S+\/)?(\d{1,20})\/?$/.exec(raw)?.[1];
  if (!id) return { error: "That doesn't look like a message ID. Right-click the giveaway message and choose **Copy Message ID** or **Copy Message Link**." };
  const gw = find(ctx, interaction.guildId, id);
  if (!gw) return { error: "I don't have a giveaway with that message ID in this server. Ended giveaways are kept for 30 days." };
  return { gw };
}

async function end(interaction, ctx) {
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to end giveaways.');
  const { gw, error } = lookup(interaction, ctx);
  if (error) return ephemeral(interaction, error);
  if (gw.status === 'cancelled') return ephemeral(interaction, 'That giveaway was cancelled.');
  if (gw.status === 'ended') return ephemeral(interaction, 'That giveaway has already ended. Use `/giveaway reroll` to draw new winners.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await finish(interaction.guild, ctx, gw.messageId);
  switch (result.outcome) {
    case 'busy': return ephemeral(interaction, 'That giveaway is already being ended.');
    case 'ended':
    case 'missing': return ephemeral(interaction, 'That giveaway has already ended.');
    case 'cancelled': return ephemeral(interaction, 'That giveaway was cancelled.');
    case 'vanished':
      return ephemeral(interaction, 'The giveaway message (or its channel) was deleted, so I cancelled the giveaway instead of drawing winners.');
  }
  const { winners, announced } = result;
  const who = winners.length ? `Winners: ${mentionList(winners)}.` : 'There were no valid entries, so nobody won.';
  const warn = announced ? '' : `\nI couldn't post the announcement in <#${gw.channelId}>, so let the winners know yourself.`;
  return ephemeral(interaction, `Ended the giveaway for **${gw.prize}**. ${who}${warn}`);
}

async function reroll(interaction, ctx) {
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to reroll giveaways.');
  const { gw, error } = lookup(interaction, ctx);
  if (error) return ephemeral(interaction, error);
  if (gw.status === 'running') return ephemeral(interaction, 'That giveaway is still running. Use `/giveaway end` to end it now.');
  if (gw.status === 'cancelled') return ephemeral(interaction, 'That giveaway was cancelled, so there is nothing to reroll.');
  if (busy.has(gw.messageId)) return ephemeral(interaction, "Hang on, I'm already drawing winners for that giveaway.");

  busy.add(gw.messageId);
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const count = interaction.options.getInteger('winners') ?? 1;
    const picked = await drawWinners(interaction.guild, gw, count, new Set([...gw.winners, ...gw.rerolled]), ctx.random);
    if (!picked.length) return ephemeral(interaction, `There's nobody else who can win **${gw.prize}**.`);
    gw.rerolled.push(...picked);
    ctx.store.save();

    const channel = interaction.guild.channels.cache.get(gw.channelId);
    let announced = false;
    if (channel?.isTextBased?.()) {
      await postEdit(channel, gw.messageId, giveawayMessage(gw, ctx.color));
      announced = await announce(channel, {
        content: `🎉 New winner${picked.length === 1 ? '' : 's'} for **${gw.prize}**: ${mentionList(picked)}. Congratulations!\n${link(interaction.guildId, gw)}`,
        allowedMentions: { users: picked },
      });
    }
    const short = picked.length < count ? ` Only ${plural(picked.length, 'person was', 'people were')} left to draw from.` : '';
    const warn = announced ? '' : `\nI couldn't post in <#${gw.channelId}>, so let the new winner${picked.length === 1 ? '' : 's'} know yourself.`;
    return ephemeral(interaction, `Rerolled **${gw.prize}**: ${mentionList(picked)}.${short}${warn}`);
  } finally {
    busy.delete(gw.messageId);
  }
}

async function cancel(interaction, ctx) {
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to cancel giveaways.');
  const { gw, error } = lookup(interaction, ctx);
  if (error) return ephemeral(interaction, error);
  if (gw.status !== 'running') return ephemeral(interaction, `That giveaway has already ${gw.status === 'cancelled' ? 'been cancelled' : 'ended'}.`);
  if (busy.has(gw.messageId)) return ephemeral(interaction, 'That giveaway is ending right now, so it can no longer be cancelled.');

  disarm(ctx, gw.messageId);
  markCancelled(ctx, gw);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = interaction.guild.channels.cache.get(gw.channelId);
  if (channel?.isTextBased?.()) await postEdit(channel, gw.messageId, giveawayMessage(gw, ctx.color));
  return ephemeral(interaction, `Cancelled the giveaway for **${gw.prize}**. No winners were drawn.`);
}

function list(interaction, ctx) {
  const running = Object.values(section(ctx, interaction.guildId).byMessage)
    .filter(gw => gw?.status === 'running')
    .filter(gw => interaction.guild.channels.cache.get(gw.channelId)?.permissionsFor(interaction.member)?.has(P.ViewChannel))
    .sort((a, b) => a.endsAt - b.endsAt);
  if (!running.length) return ephemeral(interaction, 'No giveaways are running right now.');
  let body = '';
  let shown = 0;
  for (const gw of running) {
    const prize = gw.prize.length > 80 ? `${gw.prize.slice(0, 79)}…` : gw.prize;
    const line = `**${prize}** in <#${gw.channelId}> · ends <t:${unix(gw.endsAt)}:R> · ${plural(gw.entrants.length, 'entry', 'entries')} · ${plural(gw.winnerCount, 'winner', 'winners')}\n[Jump to it](${link(interaction.guildId, gw)}) · ID \`${gw.messageId}\`\n\n`;
    if (body.length + line.length > 3900) break;
    body += line;
    shown++;
  }
  if (shown < running.length) body += `…and ${running.length - shown} more`;
  const embed = new EmbedBuilder().setColor(ctx.color).setTitle('Running giveaways').setDescription(body.trim());
  return ephemeral(interaction, null, { embeds: [embed] });
}

// ---------- the Join button ----------

function sweepClicks(t) {
  if (recentClicks.size < 1000) return;
  for (const [key, at] of recentClicks) if (t - at > DOUBLE_CLICK) recentClicks.delete(key);
}

async function join(interaction, ctx) {
  const messageId = interaction.message.id;
  const gw = find(ctx, interaction.guildId, messageId);
  const t = now(ctx);
  if (gw?.status !== 'running' || busy.has(messageId) || t >= gw.endsAt) {
    return ephemeral(interaction, 'This giveaway is no longer running.');
  }
  const userId = interaction.user.id;
  const entered = gw.entrants.includes(userId);
  // a double click would otherwise join and immediately leave again
  const key = `${messageId}:${userId}`;
  if (t - (recentClicks.get(key) ?? -Infinity) < DOUBLE_CLICK) {
    return ephemeral(interaction, entered
      ? `You're entered in the giveaway for **${gw.prize}**. To leave, press **Join** again in a moment.`
      : `You're not entered in the giveaway for **${gw.prize}**. To join, press **Join** again in a moment.`);
  }
  if (!entered && gw.requiredRoleId) {
    if (!interaction.guild.roles.cache.has(gw.requiredRoleId)) {
      return ephemeral(interaction, "The role needed for this giveaway was deleted, so I can't check who may enter. Please let a server admin know.");
    }
    if (!interaction.member.roles.cache.has(gw.requiredRoleId)) {
      return ephemeral(interaction, `You need the <@&${gw.requiredRoleId}> role to enter this giveaway.`);
    }
  }

  sweepClicks(t);
  recentClicks.set(key, t);
  if (entered) gw.entrants.splice(gw.entrants.indexOf(userId), 1);
  else gw.entrants.push(userId);
  ctx.store.save();
  await ephemeral(interaction, entered
    ? `You left the giveaway for **${gw.prize}**.`
    : `You're in the giveaway for **${gw.prize}**! It ends <t:${unix(gw.endsAt)}:R>. Press **Join** again to leave.`);
  await queueCountEdit(interaction.guild, ctx, messageId);
}

// ---------- startup ----------

function onReady(client, ctx) {
  const t = now(ctx);
  for (const [guildId, g] of Object.entries(ctx.store.data?.guilds ?? {})) {
    if (!g?.giveaways?.byMessage) continue;
    const sec = section(ctx, guildId);
    prune(sec, t);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    for (const gw of Object.values(sec.byMessage)) {
      if (gw?.status !== 'running' || !Array.isArray(gw.entrants)) continue;
      arm(client, ctx, guildId, gw.messageId); // overdue ones end on the next tick
      // a count edit may have been pending when the bot stopped
      if (gw.endsAt > t && gw.shownEntries !== gw.entrants.length) queueCountEdit(guild, ctx, gw.messageId);
    }
  }
  ctx.store.save();
}

async function execute(interaction, ctx) {
  switch (interaction.options.getSubcommand()) {
    case 'start': return start(interaction, ctx);
    case 'end': return end(interaction, ctx);
    case 'reroll': return reroll(interaction, ctx);
    case 'list': return list(interaction, ctx);
    case 'cancel': return cancel(interaction, ctx);
  }
}

module.exports = { data, execute, buttons: { join }, onReady, parseDuration, drawWinners };
