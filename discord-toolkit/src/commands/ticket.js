const {
  SlashCommandBuilder, InteractionContextType, ChannelType, OverwriteType, PermissionFlagsBits: P,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder, MessageFlags, RESTJSONErrorCodes,
} = require('discord.js');
const { ephemeral, isAdmin, botMember, cantPost, permList, channelName } = require('../lib/util');
const { buildTranscript } = require('../lib/transcript');

const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Private support tickets')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(s => s
    .setName('setup')
    .setDescription('Post the "open a ticket" panel (Manage Server)')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post the panel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption(o => o.setName('staff_role').setDescription('Role that can see and close every ticket').setRequired(true))
    .addChannelOption(o => o.setName('category').setDescription('Category to create ticket channels in').addChannelTypes(ChannelType.GuildCategory))
    .addChannelOption(o => o.setName('log_channel').setDescription('Where closed-ticket transcripts are posted').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s
    .setName('add')
    .setDescription('Let someone else see this ticket (staff)')
    .addUserOption(o => o.setName('user').setDescription('Who to add').setRequired(true)))
  .addSubcommand(s => s
    .setName('remove')
    .setDescription('Remove someone from this ticket (staff)')
    .addUserOption(o => o.setName('user').setDescription('Who to remove').setRequired(true)))
  .addSubcommand(s => s.setName('close').setDescription('Close this ticket'));

const MEMBER_PERMS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
const opening = new Set();
const closing = new Set();

const button = (id, label, emoji, style) =>
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style));

const isStaff = (member, cfg) => member.permissions.has(P.ManageGuild) || Boolean(cfg && member.roles.cache.has(cfg.staffRoleId));

// Discord only lets a bot set channel overwrites for permissions it holds server-wide.
const SERVER_PERMS_NEEDED = [P.ManageChannels, P.ManageRoles, ...MEMBER_PERMS];

async function setup(interaction, ctx) {
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to set up tickets.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = interaction.options.getChannel('channel', true);
  const staff = interaction.options.getRole('staff_role', true);
  const category = interaction.options.getChannel('category');
  const log = interaction.options.getChannel('log_channel');
  if (staff.id === interaction.guildId) return ephemeral(interaction, 'Pick an actual staff role, not @everyone, or every member could read every ticket.');

  const me = await botMember(interaction.guild);
  const missing = me.permissions.missing(SERVER_PERMS_NEEDED);
  if (missing.length) return ephemeral(interaction, `I need ${permList(missing)} server-wide (on my role) to create ticket channels.`);
  const problem = cantPost(channel, me) || (log && cantPost(log, me, { files: true }));
  if (problem) return ephemeral(interaction, problem);

  const g = ctx.store.guild(interaction.guildId);
  g.tickets.config = { staffRoleId: staff.id, categoryId: category?.id ?? null, logChannelId: log?.id ?? null };
  ctx.store.save();

  await channel.send({
    embeds: [new EmbedBuilder().setColor(ctx.color).setTitle('Need help?')
      .setDescription('Press the button below to open a private ticket with the staff team.')],
    components: [button('ticket:open', 'Open a ticket', '🎫', ButtonStyle.Primary)],
  });
  const where = category ? ` Tickets will be created in **${category.name}**.` : '';
  const logs = log ? ` Transcripts go to ${log}.` : ' No log channel set, so transcripts are DMed to the ticket owner (or handed to whoever closes it).';
  // Bots can only ping a non-mentionable role with "Mention @everyone, @here, and All Roles".
  const pingWarning = !staff.mentionable && !me.permissions.has(P.MentionEveryone)
    ? `\n⚠️ New tickets won't notify ${staff}: give my role **Mention @everyone, @here, and All Roles** (or make ${staff} mentionable).`
    : '';
  return ephemeral(interaction, `Ticket panel posted in ${channel}. Staff role: ${staff}.${where}${logs}${pingWarning}`);
}

async function open(interaction, ctx) {
  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (opening.has(key)) return ephemeral(interaction, 'Hang on, your ticket is already being created.');
  opening.add(key);
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { guild, user } = interaction;
    const g = ctx.store.guild(guild.id);
    const cfg = g.tickets.config;
    if (!cfg) return interaction.editReply('Tickets are not set up on this server yet.');

    for (const [id, t] of Object.entries(g.tickets.open)) {
      if (t.ownerId !== user.id) continue;
      if (guild.channels.cache.has(id)) return interaction.editReply(`You already have an open ticket: <#${id}>`);
      delete g.tickets.open[id]; // someone deleted the channel by hand
    }

    const me = await botMember(guild);
    const number = ++g.tickets.counter;
    ctx.store.save();
    const category = cfg.categoryId ? guild.channels.cache.get(cfg.categoryId) : null;
    const staffRole = guild.roles.cache.get(cfg.staffRoleId);
    const overwrites = [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: user.id, type: OverwriteType.Member, allow: MEMBER_PERMS },
      { id: me.id, type: OverwriteType.Member, allow: [...MEMBER_PERMS, P.ManageChannels] },
    ];
    if (staffRole) overwrites.push({ id: staffRole.id, type: OverwriteType.Role, allow: MEMBER_PERMS });

    let channel;
    try {
      channel = await guild.channels.create({
        name: channelName(`ticket-${String(number).padStart(4, '0')}-${user.username}`),
        type: ChannelType.GuildText,
        parent: category?.type === ChannelType.GuildCategory ? category.id : null,
        permissionOverwrites: overwrites,
        topic: `Ticket #${number} for ${user.tag} (${user.id})`,
        reason: `Ticket opened by ${user.tag}`,
      });
    } catch (err) {
      console.error('Creating a ticket channel failed:', err);
      const missing = me.permissions.missing(SERVER_PERMS_NEEDED);
      if (err.code === RESTJSONErrorCodes.MissingPermissions && missing.length) {
        return interaction.editReply(`I couldn't create your ticket channel: I'm missing ${permList(missing)} on my role. Please let a server admin know.`);
      }
      return interaction.editReply("I couldn't create your ticket channel. Ask an admin to check my permissions and that the ticket category isn't full (50 channels max).");
    }

    g.tickets.open[channel.id] = { ownerId: user.id, number, openedAt: Date.now() };
    ctx.store.save();
    await channel.send({
      content: staffRole ? `${user} ${staffRole}` : `${user}`,
      embeds: [new EmbedBuilder().setColor(ctx.color).setTitle(`Ticket #${number}`)
        .setDescription('Tell us what you need and a staff member will be with you soon.\nPress **Close** when you are done.')],
      components: [button('ticket:close', 'Close', '🔒', ButtonStyle.Danger)],
      allowedMentions: { users: [user.id], roles: staffRole ? [staffRole.id] : [] },
    });
    return interaction.editReply(`Your ticket is open: ${channel}`);
  } finally {
    opening.delete(key);
  }
}

// Shared by the Close button and /ticket close: checks rights, then asks for confirmation.
async function requestClose(interaction, ctx) {
  const g = ctx.store.guild(interaction.guildId);
  const t = g.tickets.open[interaction.channelId];
  if (!t) return ephemeral(interaction, 'This channel is not an open ticket.');
  if (t.ownerId !== interaction.user.id && !isStaff(interaction.member, g.tickets.config)) {
    return ephemeral(interaction, 'Only the person who opened this ticket or staff can close it.');
  }
  return interaction.reply({
    content: 'Close this ticket? A transcript is saved before the channel is deleted.',
    components: [button('ticket:confirm', 'Yes, close it', '🔒', ButtonStyle.Danger)],
    flags: MessageFlags.Ephemeral,
  });
}

async function confirmClose(interaction, ctx) {
  const g = ctx.store.guild(interaction.guildId);
  const channel = interaction.channel;
  const t = g.tickets.open[channel.id];
  if (!t) return ephemeral(interaction, 'This ticket is already closed.');
  if (t.ownerId !== interaction.user.id && !isStaff(interaction.member, g.tickets.config)) {
    return ephemeral(interaction, 'Only the person who opened this ticket or staff can close it.');
  }
  if (closing.has(channel.id)) return ephemeral(interaction, 'This ticket is already closing.');
  closing.add(channel.id);
  try {
    await interaction.update({ content: 'Closing…', components: [] });
    await channel.send({
      embeds: [new EmbedBuilder().setColor(ctx.color).setDescription(`🔒 Closed by ${interaction.user}. This channel will be deleted in a few seconds.`)],
    });

    const label = `ticket-${String(t.number).padStart(4, '0')}`;
    const { text, count, truncated } = await buildTranscript(channel, `Transcript for ticket #${t.number}`);
    const file = () => new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `${label}.txt` });
    const cfg = g.tickets.config || {};

    // The channel is only deleted once the transcript has landed somewhere.
    let saved = false;
    const log = cfg.logChannelId ? interaction.guild.channels.cache.get(cfg.logChannelId) : null;
    if (log?.isTextBased()) {
      const summary = new EmbedBuilder().setColor(ctx.color).setTitle(`Ticket #${t.number} closed`).setTimestamp()
        .addFields(
          { name: 'Opened by', value: `<@${t.ownerId}>`, inline: true },
          { name: 'Closed by', value: `${interaction.user}`, inline: true },
          { name: 'Messages', value: `${count}${truncated ? ' (oldest and newest kept)' : ''}`, inline: true },
        );
      saved = await log.send({ embeds: [summary], files: [file()] })
        .then(() => true, err => { console.error('Posting the transcript failed:', err.message); return false; });
    }
    const dmed = await interaction.client.users
      .send(t.ownerId, { content: `Your ticket #${t.number} in **${interaction.guild.name}** was closed. Here's the transcript.`, files: [file()] })
      .then(() => true, () => false);
    if (!saved && !dmed) {
      saved = await interaction
        .followUp({ content: "I couldn't post the transcript to a log channel or DM it to the ticket owner, so here it is. Download it before dismissing this.", files: [file()], flags: MessageFlags.Ephemeral })
        .then(() => true, () => false);
    }
    if (!saved && !dmed) {
      closing.delete(channel.id);
      await channel.send("Close cancelled: I couldn't save the transcript anywhere, so I'm keeping this channel. An admin can run `/ticket setup` with a log channel I can post files in, then close again.");
      return;
    }
  } catch (err) {
    closing.delete(channel.id);
    throw err;
  }
  // The record is only dropped once the channel is really gone, so a restart mid-close leaves a ticket
  // that can simply be closed again instead of an orphan channel.
  setTimeout(() => {
    channel.delete(`Ticket closed by ${interaction.user.tag}`)
      .then(() => {}, err => { if (err.code !== RESTJSONErrorCodes.UnknownChannel) throw err; })
      .then(() => {
        delete g.tickets.open[channel.id];
        ctx.store.save();
      })
      .catch(err => console.error('Deleting the ticket channel failed:', err.message))
      .finally(() => closing.delete(channel.id));
  }, ctx.ticketDeleteDelayMs ?? 5000);
}

async function addOrRemove(interaction, ctx, adding) {
  const g = ctx.store.guild(interaction.guildId);
  const t = g.tickets.open[interaction.channelId];
  if (!t) return ephemeral(interaction, 'Use this inside a ticket channel.');
  if (!isStaff(interaction.member, g.tickets.config)) return ephemeral(interaction, 'Only staff can change who is in a ticket.');
  const user = interaction.options.getUser('user', true);
  if (adding) {
    await interaction.channel.permissionOverwrites.edit(
      user,
      { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true },
      { type: OverwriteType.Member, reason: `Added to ticket by ${interaction.user.tag}` },
    );
    return interaction.reply({ content: `${user} was added to this ticket.`, allowedMentions: { users: [user.id] } });
  }
  if (user.id === t.ownerId) return ephemeral(interaction, "You can't remove the person who opened the ticket. Close it instead.");
  await interaction.channel.permissionOverwrites.delete(user, `Removed from ticket by ${interaction.user.tag}`);
  return interaction.reply({ content: `${user} was removed from this ticket.`, allowedMentions: { parse: [] } });
}

async function execute(interaction, ctx) {
  switch (interaction.options.getSubcommand()) {
    case 'setup': return setup(interaction, ctx);
    case 'add': return addOrRemove(interaction, ctx, true);
    case 'remove': return addOrRemove(interaction, ctx, false);
    case 'close': return requestClose(interaction, ctx);
  }
}

module.exports = {
  data,
  execute,
  buttons: { open, close: requestClose, confirm: confirmClose },
};
