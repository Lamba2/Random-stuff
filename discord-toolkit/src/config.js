const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

function parseColor(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec((value || '').trim());
  return m ? parseInt(m[1], 16) : 0x5865f2;
}

module.exports = {
  token: (process.env.DISCORD_TOKEN || '').trim(),
  guildId: (process.env.GUILD_ID || '').trim(),
  dataFile: path.resolve(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'store.json')),
  color: parseColor(process.env.EMBED_COLOR),
  parseColor,
};
