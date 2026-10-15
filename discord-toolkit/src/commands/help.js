const { SlashCommandBuilder, InteractionContextType, EmbedBuilder } = require('discord.js');
const { ephemeral } = require('../lib/util');

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('What this bot can do')
  .setContexts(InteractionContextType.Guild);

const SECTIONS = [
  ['🎫 Tickets', '`/ticket setup` posts the panel · `/ticket add` / `/ticket remove` manage who is in a ticket · `/ticket close` closes it with a transcript'],
  ['✅ Verification', '`/verify setup` posts a verify button with an optional math captcha'],
  ['🏷️ Role buttons', '`/roles panel` posts up to 5 buttons members press to add or remove roles'],
  ['⭐ Vouches', '`/vouch give` · `/vouch view` · `/vouch channel` (admin) · `/vouch remove` (admin)'],
  ['📦 Stock', '`/stock set` · `/stock remove` · `/stock view` · `/stock panel` posts a list that updates itself, with optional restock pings'],
  ['🎲 Dice', '`/roll 2d6+3`'],
];

async function execute(interaction, ctx) {
  const embed = new EmbedBuilder().setColor(ctx.color).setTitle('Commands')
    .addFields(SECTIONS.map(([name, value]) => ({ name, value })))
    .setFooter({ text: 'Setup commands need the Manage Server permission.' });
  return ephemeral(interaction, null, { embeds: [embed] });
}

module.exports = { data, execute };
