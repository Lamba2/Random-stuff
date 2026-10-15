const { SlashCommandBuilder, InteractionContextType, ChannelType, EmbedBuilder } = require('discord.js');
const { ephemeral, isAdmin, botMember, cantPost, stars } = require('../lib/util');

const DAY = 24 * 60 * 60 * 1000;

const data = new SlashCommandBuilder()
  .setName('vouch')
  .setDescription('Vouches and reputation')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(s => s
    .setName('give')
    .setDescription('Vouch for someone you traded with')
    .addUserOption(o => o.setName('user').setDescription('Who you are vouching for').setRequired(true))
    .addIntegerOption(o => o.setName('rating').setDescription('How did it go?').setRequired(true).addChoices(
      { name: '★★★★★ 5', value: 5 }, { name: '★★★★☆ 4', value: 4 }, { name: '★★★☆☆ 3', value: 3 },
      { name: '★★☆☆☆ 2', value: 2 }, { name: '★☆☆☆☆ 1', value: 1 }))
    .addStringOption(o => o.setName('comment').setDescription('What happened').setRequired(true).setMaxLength(300)))
  .addSubcommand(s => s
    .setName('view')
    .setDescription("See someone's vouches")
    .addUserOption(o => o.setName('user').setDescription('Whose vouches to show').setRequired(true)))
  .addSubcommand(s => s
    .setName('channel')
    .setDescription('Post new vouches in a dedicated channel (Manage Server)')
    .addChannelOption(o => o.setName('channel').setDescription('The vouch channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand(s => s
    .setName('remove')
    .setDescription('Delete a vouch by its number (Manage Server)')
    .addUserOption(o => o.setName('user').setDescription('Who received the vouch').setRequired(true))
    .addIntegerOption(o => o.setName('number').setDescription('The vouch number, shown as #12').setRequired(true).setMinValue(1)));

function summary(list) {
  const avg = list.reduce((a, v) => a + v.rating, 0) / list.length;
  return { count: list.length, avg: Math.round(avg * 10) / 10 };
}

async function give(interaction, ctx) {
  const target = interaction.options.getUser('user', true);
  const rating = interaction.options.getInteger('rating', true);
  const comment = interaction.options.getString('comment', true).replace(/\s+/g, ' ').trim();
  if (target.bot) return ephemeral(interaction, "You can't vouch for a bot.");
  if (target.id === interaction.user.id) return ephemeral(interaction, "You can't vouch for yourself.");
  if (!comment) return ephemeral(interaction, 'Add a short comment about how it went.');

  const g = ctx.store.guild(interaction.guildId);
  const list = (g.vouches.byUser[target.id] ||= []);
  const now = Date.now();
  if (list.some(v => v.from === interaction.user.id && now - v.at < DAY)) {
    return ephemeral(interaction, `You already vouched for ${target} in the last 24 hours.`);
  }
  const vouch = { id: g.vouches.nextId++, from: interaction.user.id, rating, comment, at: now };
  list.push(vouch);
  ctx.store.save();

  const { count, avg } = summary(list);
  const embed = new EmbedBuilder().setColor(ctx.color)
    .setAuthor({ name: `Vouch for ${target.username}`, iconURL: target.displayAvatarURL() })
    .setDescription(`${stars(rating)}\n> ${comment}`)
    .addFields(
      { name: 'For', value: `${target}`, inline: true },
      { name: 'From', value: `${interaction.user}`, inline: true },
    )
    .setFooter({ text: `Vouch #${vouch.id} · ${target.username} now has ${count} vouch${count === 1 ? '' : 'es'}, ${avg} average` })
    .setTimestamp(now);

  const dest = g.vouches.channelId ? interaction.guild.channels.cache.get(g.vouches.channelId) : null;
  if (dest && dest.id !== interaction.channelId && !cantPost(dest, await botMember(interaction.guild))) {
    await dest.send({ embeds: [embed] });
    return ephemeral(interaction, `Thanks! Your vouch was posted in ${dest}.`);
  }
  return interaction.reply({ embeds: [embed] });
}

async function view(interaction, ctx) {
  const target = interaction.options.getUser('user', true);
  const list = ctx.store.guild(interaction.guildId).vouches.byUser[target.id] || [];
  if (!list.length) return interaction.reply({ content: `${target} has no vouches yet.`, allowedMentions: { parse: [] } });
  const { count, avg } = summary(list);
  const recent = list.slice(-5).reverse()
    .map(v => `**#${v.id}** ${stars(v.rating)} from <@${v.from}> <t:${Math.floor(v.at / 1000)}:R>\n> ${v.comment}`);
  const embed = new EmbedBuilder().setColor(ctx.color)
    .setAuthor({ name: `${target.username}'s vouches`, iconURL: target.displayAvatarURL() })
    .setDescription(`**${count}** vouch${count === 1 ? '' : 'es'} · **${avg}** ${stars(Math.round(avg))}\n\n${recent.join('\n\n')}`)
    .setFooter({ text: count > 5 ? `Showing the 5 most recent of ${count}` : 'All vouches shown' });
  return interaction.reply({ embeds: [embed] });
}

async function setChannel(interaction, ctx) {
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to change the vouch channel.');
  const channel = interaction.options.getChannel('channel', true);
  const problem = cantPost(channel, await botMember(interaction.guild));
  if (problem) return ephemeral(interaction, problem);
  ctx.store.guild(interaction.guildId).vouches.channelId = channel.id;
  ctx.store.save();
  return ephemeral(interaction, `New vouches will be posted in ${channel}.`);
}

async function remove(interaction, ctx) {
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to remove vouches.');
  const target = interaction.options.getUser('user', true);
  const number = interaction.options.getInteger('number', true);
  const list = ctx.store.guild(interaction.guildId).vouches.byUser[target.id] || [];
  const index = list.findIndex(v => v.id === number);
  if (index === -1) return ephemeral(interaction, `${target} has no vouch #${number}.`);
  list.splice(index, 1);
  ctx.store.save();
  return ephemeral(interaction, `Removed vouch #${number} from ${target}.`);
}

async function execute(interaction, ctx) {
  switch (interaction.options.getSubcommand()) {
    case 'give': return give(interaction, ctx);
    case 'view': return view(interaction, ctx);
    case 'channel': return setChannel(interaction, ctx);
    case 'remove': return remove(interaction, ctx);
  }
}

module.exports = { data, execute };
