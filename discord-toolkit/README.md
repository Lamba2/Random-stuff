# Discord Community Toolkit

One bot that covers what shop, game and community servers usually need. It's all set up with slash commands, so there are no config files to edit.

| Feature | Commands |
|---------|----------|
| **Tickets**: private support channels, staff role, transcripts to a log channel and to the user's DMs | `/ticket setup` · `/ticket add` · `/ticket remove` · `/ticket close` |
| **Verification**: verify button with an optional math captcha that gives a role | `/verify setup` |
| **Role buttons**: members press a button to add or remove a role (up to 5 per panel) | `/roles panel` |
| **Vouches**: 1–5 star reviews with a 24h cooldown per pair, averages, and an optional vouch channel | `/vouch give` · `/vouch view` · `/vouch channel` · `/vouch remove` |
| **Stock**: an item list that updates itself, with optional pings when something is restocked | `/stock set` · `/stock remove` · `/stock view` · `/stock panel` |
| **Dice** | `/roll 2d6+3` |

Setup commands need the **Manage Server** permission. Data is saved in `data/store.json`, so no database is needed.

## Setup (about 10 minutes)

**You need [Node.js](https://nodejs.org) 18.17 or newer.**

1. **Create the bot.** Go to <https://discord.com/developers/applications> → **New Application** → **Bot** tab → **Reset Token**, then copy the token.
2. **Optional: full transcripts.** On the same Bot tab, turn on **Message Content Intent**. Without it, ticket transcripts only contain the bot's own messages and attachments.
3. **Install:**
   ```bash
   npm install
   cp .env.example .env      # then paste the token after DISCORD_TOKEN=
   ```
4. **Run:**
   ```bash
   npm start
   ```
   The console prints an **invite link** with exactly the permissions the bot needs. Open it and add the bot to your server.
5. **Move the bot's role up.** In Server Settings → Roles, drag the bot's role **above** every role it should hand out (verified, colors, etc.). Discord only lets bots assign roles below their own.
6. Run the setup commands you want, for example `/ticket setup`, `/verify setup` or `/roles panel`.

Commands can take a minute to show up the first time. Set `GUILD_ID` in `.env` to make them appear instantly in one server.

## Keeping it online

The bot only runs while `npm start` is running. To keep it online around the clock, run it on a VPS or any Node host with [pm2](https://pm2.keymetrics.io): `npx pm2 start src/index.js --name toolkit`.

## Tests

```bash
npm test
```

There are 53 tests. They run every feature against a simulated Discord, covering permissions, double clicks, deleted channels and roles, closed DMs, and corrupted data files.
