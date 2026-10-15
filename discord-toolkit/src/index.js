const { Client, GatewayIntentBits, Events, OAuth2Scopes, PermissionFlagsBits: P } = require('discord.js');
const config = require('./config');
const { Store } = require('./store');
const { commands } = require('./commands');
const { buildRouter } = require('./router');

const INVITE_PERMISSIONS = [
  P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory,
  P.ManageChannels, P.ManageRoles,
  P.MentionEveryone, // lets staff and restock pings reach roles that aren't set to mentionable
];

if (!config.token) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and paste your bot token into it.');
  process.exit(1);
}

const store = new Store(config.dataFile);
const ctx = { store, color: config.color };
const route = buildRouter(commands);
// Guilds is the only intent needed: everything else arrives through interactions.
// Nothing pings unless a message opts in: the bot holds Mention Everyone, and user text (vouch
// comments, item names) must never be able to reach @everyone through it.
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [], repliedUser: false } });

client.once(Events.ClientReady, async c => {
  console.log(`Logged in as ${c.user.tag}, in ${c.guilds.cache.size} server(s).`);
  const body = commands.map(cmd => cmd.data.toJSON());
  try {
    if (config.guildId) {
      await c.application.commands.set(body, config.guildId);
      console.log(`Registered ${body.length} slash commands in server ${config.guildId}.`);
    } else {
      await c.application.commands.set(body);
      console.log(`Registered ${body.length} slash commands globally.`);
    }
  } catch (err) {
    console.error('Registering slash commands failed:', err.message);
  }
  const invite = c.generateInvite({ scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands], permissions: INVITE_PERMISSIONS });
  console.log(`Invite link: ${invite}`);
});

client.on(Events.InteractionCreate, interaction => route(interaction, ctx));
client.on(Events.Error, err => console.error('Discord client error:', err));
process.on('unhandledRejection', err => console.error('Unhandled promise rejection:', err));

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    store.flush();
  } catch (err) {
    console.error('Final save failed:', err);
  }
  client.destroy().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(config.token).catch(err => {
  console.error(`Login failed: ${err.message}\nCheck DISCORD_TOKEN in .env.`);
  process.exit(1);
});
