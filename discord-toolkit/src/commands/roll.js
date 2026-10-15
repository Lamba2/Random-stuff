const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const { ephemeral, parseDice, rollDice } = require('../lib/util');

const data = new SlashCommandBuilder()
  .setName('roll')
  .setDescription('Roll dice, like 1d20 or 2d6+3')
  .setContexts(InteractionContextType.Guild)
  .addStringOption(o => o.setName('dice').setDescription('Dice to roll (default 1d6)').setMaxLength(20));

async function execute(interaction) {
  const text = interaction.options.getString('dice') || '1d6';
  const dice = parseDice(text);
  if (!dice) return ephemeral(interaction, 'Use dice like `1d20`, `2d6` or `3d8+2` (up to 50 dice, 2–1000 sides).');
  const { rolls, total } = rollDice(dice);
  const mod = dice.modifier ? ` ${dice.modifier > 0 ? '+' : '-'} ${Math.abs(dice.modifier)}` : '';
  const shown = rolls.length > 1 || mod ? ` → [${rolls.join(', ')}]${mod}` : '';
  const label = `${dice.count}d${dice.sides}${dice.modifier ? (dice.modifier > 0 ? '+' : '') + dice.modifier : ''}`;
  return interaction.reply({ content: `🎲 ${interaction.user} rolled **${label}**${shown} = **${total}**`, allowedMentions: { parse: [] } });
}

module.exports = { data, execute };
