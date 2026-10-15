const { SlashCommandBuilder, InteractionContextType, ChannelType, EmbedBuilder, RESTJSONErrorCodes } = require('discord.js');
const { ephemeral, isAdmin, botMember, cantPost } = require('../lib/util');

const data = new SlashCommandBuilder()
  .setName('stock')
  .setDescription('Track what you have in stock')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(s => s
    .setName('set')
    .setDescription('Add an item or change its quantity (Manage Server)')
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true).setMaxLength(60))
    .addIntegerOption(o => o.setName('quantity').setDescription('How many are in stock').setRequired(true).setMinValue(0).setMaxValue(1_000_000))
    .addStringOption(o => o.setName('price').setDescription('Price to show, e.g. $5 or 500 Robux').setMaxLength(30)))
  .addSubcommand(s => s
    .setName('remove')
    .setDescription('Delete an item from the list (Manage Server)')
    .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true).setMaxLength(60)))
  .addSubcommand(s => s.setName('view').setDescription("See what's in stock"))
  .addSubcommand(s => s
    .setName('panel')
    .setDescription('Post a stock list that updates itself (Manage Server)')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption(o => o.setName('restock_ping').setDescription('Role to ping when something comes back in stock')));

const MAX_LIST = 3800;

function stockEmbed(items, color) {
  const lines = Object.values(items)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(i => {
      const price = i.price ? ` · ${i.price}` : '';
      return i.quantity > 0 ? `🟢 **${i.name}**: ${i.quantity} in stock${price}` : `🔴 **${i.name}**: sold out${price}`;
    });
  let body = '';
  let shown = 0;
  for (const line of lines) {
    if (body.length + line.length + 1 > MAX_LIST) break;
    body += `${line}\n`;
    shown++;
  }
  if (shown < lines.length) body += `…and ${lines.length - shown} more`;
  return new EmbedBuilder().setColor(color).setTitle('Stock').setDescription(body || 'Nothing listed yet.').setTimestamp();
}

async function refreshPanel(guild, ctx) {
  const g = ctx.store.guild(guild.id);
  const panel = g.stock.panel;
  if (!panel) return;
  const channel = guild.channels.cache.get(panel.channelId);
  if (!channel?.isTextBased()) {
    g.stock.panel = null;
    ctx.store.save();
    return;
  }
  try {
    const message = await channel.messages.fetch(panel.messageId);
    await message.edit({ embeds: [stockEmbed(g.stock.items, ctx.color)] });
  } catch (err) {
    if (err.code === RESTJSONErrorCodes.UnknownMessage) {
      g.stock.panel = null; // panel was deleted; stop trying to update it
      ctx.store.save();
    } else {
      console.error('Updating the stock panel failed:', err.message);
    }
  }
}

async function set(interaction, ctx) {
  const name = interaction.options.getString('item', true).replace(/\s+/g, ' ').trim();
  const quantity = interaction.options.getInteger('quantity', true);
  const price = interaction.options.getString('price')?.trim() || null;
  if (!name) return ephemeral(interaction, 'Give the item a name.');
  const g = ctx.store.guild(interaction.guildId);
  const key = name.toLowerCase();
  const before = g.stock.items[key];
  g.stock.items[key] = { name, quantity, price: price ?? before?.price ?? null };
  ctx.store.save();
  await refreshPanel(interaction.guild, ctx);

  const restocked = quantity > 0 && (!before || before.quantity === 0);
  const { panel, notifyRoleId } = g.stock;
  const pingChannel = panel ? interaction.guild.channels.cache.get(panel.channelId) : null;
  if (restocked && notifyRoleId && pingChannel?.isTextBased()) {
    await pingChannel.send({
      content: `<@&${notifyRoleId}> **${name}** is in stock (${quantity} available).`,
      allowedMentions: { roles: [notifyRoleId] },
    }).catch(err => console.error('Restock ping failed:', err.message));
  }
  return ephemeral(interaction, `**${name}** set to ${quantity}${g.stock.items[key].price ? ` at ${g.stock.items[key].price}` : ''}.`);
}

async function remove(interaction, ctx) {
  const name = interaction.options.getString('item', true).replace(/\s+/g, ' ').trim();
  const g = ctx.store.guild(interaction.guildId);
  const key = name.toLowerCase();
  if (!g.stock.items[key]) return ephemeral(interaction, `There's no item called **${name}**. Check /stock view for the exact name.`);
  const shown = g.stock.items[key].name;
  delete g.stock.items[key];
  ctx.store.save();
  await refreshPanel(interaction.guild, ctx);
  return ephemeral(interaction, `Removed **${shown}**.`);
}

async function panel(interaction, ctx) {
  const channel = interaction.options.getChannel('channel', true);
  const role = interaction.options.getRole('restock_ping');
  const problem = cantPost(channel, await botMember(interaction.guild), { history: true });
  if (problem) return ephemeral(interaction, problem);
  if (role && role.id === interaction.guildId) return ephemeral(interaction, "Pick a dedicated restock role instead of @everyone.");
  const g = ctx.store.guild(interaction.guildId);
  const old = g.stock.panel;
  const message = await channel.send({ embeds: [stockEmbed(g.stock.items, ctx.color)] });
  g.stock.panel = { channelId: channel.id, messageId: message.id };
  g.stock.notifyRoleId = role?.id ?? null;
  ctx.store.save();
  if (old) {
    const oldChannel = interaction.guild.channels.cache.get(old.channelId);
    oldChannel?.messages?.delete(old.messageId).catch(() => {}); // old panel would go stale otherwise
  }
  return ephemeral(interaction, `Stock panel posted in ${channel}. It updates whenever you use /stock set or /stock remove.${role ? ` ${role} gets pinged on restocks.` : ''}`);
}

async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'view') {
    return ephemeral(interaction, null, { embeds: [stockEmbed(ctx.store.guild(interaction.guildId).stock.items, ctx.color)] });
  }
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to change stock.');
  if (sub === 'set') return set(interaction, ctx);
  if (sub === 'remove') return remove(interaction, ctx);
  if (sub === 'panel') return panel(interaction, ctx);
}

module.exports = { data, execute, stockEmbed, refreshPanel };
