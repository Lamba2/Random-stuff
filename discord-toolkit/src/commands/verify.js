const {
  SlashCommandBuilder, InteractionContextType, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { ephemeral, isAdmin, botMember, roleProblem, cantPost } = require('../lib/util');

const data = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Verification gate for new members')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(s => s
    .setName('setup')
    .setDescription('Post the verify button (Manage Server)')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post the verify button').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role given to verified members').setRequired(true))
    .addBooleanOption(o => o.setName('captcha').setDescription('Ask a quick math question first to stop bots (default: on)')));

async function setup(interaction, ctx) {
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to set up verification.');
  const channel = interaction.options.getChannel('channel', true);
  const role = interaction.options.getRole('role', true);
  const captcha = interaction.options.getBoolean('captcha') ?? true;
  const me = await botMember(interaction.guild);
  const problem = roleProblem(role, me) || cantPost(channel, me);
  if (problem) return ephemeral(interaction, problem);

  const g = ctx.store.guild(interaction.guildId);
  g.verify = { roleId: role.id, captcha };
  ctx.store.save();
  await channel.send({
    embeds: [new EmbedBuilder().setColor(ctx.color).setTitle('Verify to get access')
      .setDescription('Press **Verify** below to unlock the rest of the server.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify:start').setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success))],
  });
  return ephemeral(interaction, `Verify button posted in ${channel}. Verified members get ${role}. Captcha is **${captcha ? 'on' : 'off'}**.`);
}

async function grant(interaction, ctx) {
  const { roleId } = ctx.store.guild(interaction.guildId).verify;
  const role = roleId ? interaction.guild.roles.cache.get(roleId) : null;
  const problem = roleProblem(role, await botMember(interaction.guild));
  if (problem) return ephemeral(interaction, `I couldn't verify you: ${problem} Please let a server admin know.`);
  if (interaction.member.roles.cache.has(role.id)) return ephemeral(interaction, 'You are already verified.');
  await interaction.member.roles.add(role, 'Passed verification');
  return ephemeral(interaction, `You're verified. Welcome to **${interaction.guild.name}**!`);
}

async function start(interaction, ctx) {
  const v = ctx.store.guild(interaction.guildId).verify;
  if (!v.roleId) return ephemeral(interaction, 'Verification is not set up on this server.');
  if (interaction.member.roles.cache.has(v.roleId)) return ephemeral(interaction, 'You are already verified.');
  if (!v.captcha) return grant(interaction, ctx);
  const a = 2 + Math.floor(Math.random() * 9);
  const b = 2 + Math.floor(Math.random() * 9);
  return interaction.showModal(new ModalBuilder()
    .setCustomId(`verify:check:${a}:${b}`)
    .setTitle('Quick check')
    .addLabelComponents(new LabelBuilder()
      .setLabel(`What is ${a} + ${b}?`)
      .setTextInputComponent(new TextInputBuilder().setCustomId('answer').setStyle(TextInputStyle.Short).setMaxLength(4).setRequired(true))));
}

async function check(interaction, ctx, [a, b]) {
  const answer = interaction.fields.getTextInputValue('answer').trim();
  if (!/^\d+$/.test(answer) || Number(answer) !== Number(a) + Number(b)) {
    return ephemeral(interaction, "That's not right. Press **Verify** to try again.");
  }
  return grant(interaction, ctx);
}

module.exports = {
  data,
  execute: setup, // only subcommand
  buttons: { start },
  modals: { check },
};
