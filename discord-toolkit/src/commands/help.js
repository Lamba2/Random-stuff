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
  ['🛒 Shop', '`/shop add` · `/shop remove` · `/shop list` · `/shop payment` (admin) · `/shop panel` (admin) posts a catalog; picking a product opens a private order ticket with **Mark paid** and **Delivered** buttons · `/shop orders` · `/shop deliver` · `/shop cancel` (admin). Needs `/ticket setup` first'],
  ['🎉 Giveaways', '`/giveaway start` posts a giveaway with a Join button (durations like `1h30m`, up to 30 days, optional required role) · `/giveaway end` · `/giveaway reroll` · `/giveaway cancel` · `/giveaway list`'],
  ['📝 Applications', '`/application create` makes a form · `/application question add` / `remove` / `list` (up to 40 questions) · `/application panel` posts the Apply button · `/application edit` · `/application delete` · `/application status` lets applicants check on theirs'],
  ['🎲 Dice', '`/roll 2d6+3`'],
];

async function execute(interaction, ctx) {
  const embed = new EmbedBuilder().setColor(ctx.color).setTitle('Commands')
    .addFields(SECTIONS.map(([name, value]) => ({ name, value })))
    .setFooter({ text: 'Setup commands need the Manage Server permission.' });
  return ephemeral(interaction, null, { embeds: [embed] });
}

module.exports = { data, execute };
