const { MessageFlags, PermissionFlagsBits: P } = require('discord.js');

// Reply privately, whatever state the interaction is in.
async function ephemeral(interaction, content, extra = {}) {
  const body = content == null ? { ...extra } : { content, ...extra };
  if (interaction.replied) return interaction.followUp({ ...body, flags: MessageFlags.Ephemeral });
  if (interaction.deferred) return interaction.editReply(body);
  return interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
}

const isAdmin = interaction => Boolean(interaction.memberPermissions?.has(P.ManageGuild));

async function botMember(guild) {
  return guild.members.me ?? guild.members.fetchMe();
}

// Why the bot can't hand out this role, or null if it can.
function roleProblem(role, me) {
  if (!role) return 'That role no longer exists.';
  if (role.id === role.guild.id) return "I can't hand out @everyone.";
  if (role.managed) return `**${role.name}** belongs to a bot or integration, so I can't assign it.`;
  if (!me.permissions.has(P.ManageRoles)) return 'I need the **Manage Roles** permission.';
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return `My highest role has to be above **${role.name}**. Drag my role higher in Server Settings → Roles.`;
  }
  return null;
}

const PERM_NAMES = {
  ViewChannel: 'View Channel',
  SendMessages: 'Send Messages',
  EmbedLinks: 'Embed Links',
  AttachFiles: 'Attach Files',
  ReadMessageHistory: 'Read Message History',
  ManageChannels: 'Manage Channels',
  ManageRoles: 'Manage Roles',
};
const permList = names => names.map(n => `**${PERM_NAMES[n] || n}**`).join(', ');

// Why the bot can't post in this channel, or null if it can.
function cantPost(channel, me, { files = false, history = false } = {}) {
  const need = [P.ViewChannel, P.SendMessages, P.EmbedLinks];
  if (files) need.push(P.AttachFiles);
  if (history) need.push(P.ReadMessageHistory);
  const perms = channel.permissionsFor(me);
  const missing = perms ? perms.missing(need) : ['ViewChannel', 'SendMessages', 'EmbedLinks'];
  return missing.length ? `I can't post in ${channel}: I'm missing ${permList(missing)} there.` : null;
}

// Discord text channel names: lowercase, digits, dashes, underscores, max 100 chars.
function channelName(raw) {
  const name = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return name || 'ticket';
}

const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);

// "2d6+1" -> { count: 2, sides: 6, modifier: 1 }, or null if it's not valid dice notation.
function parseDice(text) {
  const m = /^\s*(\d{0,2})\s*d\s*(\d{1,4})\s*(?:([+-])\s*(\d{1,4}))?\s*$/i.exec(text || '');
  if (!m) return null;
  const count = m[1] === '' ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  const modifier = m[3] ? Number(m[4]) * (m[3] === '-' ? -1 : 1) : 0;
  if (count < 1 || count > 50 || sides < 2 || sides > 1000) return null;
  return { count, sides, modifier };
}

function rollDice({ count, sides, modifier }, rng = Math.random) {
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(rng() * sides));
  return { rolls, total: rolls.reduce((a, b) => a + b, 0) + modifier };
}

module.exports = { ephemeral, isAdmin, botMember, roleProblem, cantPost, permList, channelName, stars, parseDice, rollDice };
