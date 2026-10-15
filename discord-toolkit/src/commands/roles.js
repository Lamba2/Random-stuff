const {
  SlashCommandBuilder, InteractionContextType, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} = require('discord.js');
const { ephemeral, isAdmin, botMember, roleProblem, cantPost } = require('../lib/util');

const data = new SlashCommandBuilder()
  .setName('roles')
  .setDescription('Self-assign role buttons')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(s => {
    s.setName('panel')
      .setDescription('Post buttons members press to add or remove roles (Manage Server)')
      .addChannelOption(o => o.setName('channel').setDescription('Where to post the panel').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption(o => o.setName('role1').setDescription('First role').setRequired(true));
    for (let i = 2; i <= 5; i++) s.addRoleOption(o => o.setName(`role${i}`).setDescription(`Role ${i}`));
    return s
      .addStringOption(o => o.setName('title').setDescription('Panel title').setMaxLength(200))
      .addStringOption(o => o.setName('description').setDescription('Panel text').setMaxLength(1000));
  });

async function panel(interaction, ctx) {
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to post role panels.');
  const channel = interaction.options.getChannel('channel', true);
  const roles = [];
  for (let i = 1; i <= 5; i++) {
    const role = interaction.options.getRole(`role${i}`);
    if (role && !roles.some(r => r.id === role.id)) roles.push(role);
  }
  const me = await botMember(interaction.guild);
  const problems = roles.map(r => roleProblem(r, me)).filter(Boolean);
  const postProblem = cantPost(channel, me);
  if (postProblem) problems.push(postProblem);
  if (problems.length) return ephemeral(interaction, problems.join('\n'));

  const title = interaction.options.getString('title') || 'Pick your roles';
  const description = interaction.options.getString('description') || 'Press a button to add a role. Press it again to remove it.';
  await channel.send({
    embeds: [new EmbedBuilder().setColor(ctx.color).setTitle(title)
      .setDescription(`${description}\n\n${roles.map(r => `• ${r}`).join('\n')}`)],
    components: [new ActionRowBuilder().addComponents(roles.map(r =>
      new ButtonBuilder().setCustomId(`roles:toggle:${r.id}`).setLabel(r.name.slice(0, 80)).setStyle(ButtonStyle.Secondary)))],
  });
  return ephemeral(interaction, `Role panel posted in ${channel} with ${roles.length} role${roles.length === 1 ? '' : 's'}.`);
}

async function toggle(interaction, ctx, [roleId]) {
  const role = interaction.guild.roles.cache.get(roleId);
  const problem = roleProblem(role, await botMember(interaction.guild));
  if (problem) return ephemeral(interaction, `I can't change that role: ${problem} Please let a server admin know.`);
  if (interaction.member.roles.cache.has(role.id)) {
    await interaction.member.roles.remove(role, 'Role panel');
    return ephemeral(interaction, `Removed ${role}.`);
  }
  await interaction.member.roles.add(role, 'Role panel');
  return ephemeral(interaction, `Added ${role}.`);
}

module.exports = { data, execute: panel, buttons: { toggle } };
