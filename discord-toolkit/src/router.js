const { ephemeral } = require('./lib/util');

// customIds look like "<command>:<action>:<arg>…", so each feature owns its own buttons, select menus and modals.
function handlerTable(cmd, interaction) {
  if (!cmd) return null;
  if (interaction.isButton()) return cmd.buttons;
  if (interaction.isStringSelectMenu?.()) return cmd.selects;
  if (interaction.isModalSubmit()) return cmd.modals;
  return null;
}

function buildRouter(commands) {
  const byName = new Map(commands.map(c => [c.data.name, c]));

  return async function route(interaction, ctx) {
    try {
      if (interaction.isChatInputCommand()) {
        const cmd = byName.get(interaction.commandName);
        if (!cmd) return;
        if (!interaction.inCachedGuild()) {
          await ephemeral(interaction, 'Use this inside a server where I was invited with the bot scope.');
          return;
        }
        await cmd.execute(interaction, ctx);
        return;
      }
      if (typeof interaction.customId === 'string') {
        const [name, action, ...args] = interaction.customId.split(':');
        const handler = handlerTable(byName.get(name), interaction)?.[action];
        if (!handler || !interaction.inCachedGuild()) return;
        await handler(interaction, ctx, args);
      }
    } catch (err) {
      const what = interaction.isChatInputCommand?.() ? `/${interaction.commandName}` : interaction.customId;
      console.error(`Error while handling ${what}:`, err);
      try {
        await ephemeral(interaction, 'Something went wrong on my end. A server admin can check the bot console for details.');
      } catch {
        // the interaction may have expired; nothing more to do
      }
    }
  };
}

module.exports = { buildRouter };
