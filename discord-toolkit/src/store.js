const fs = require('node:fs');
const path = require('node:path');

const defaults = () => ({
  tickets: { config: null, counter: 0, open: {} },
  verify: { roleId: null, captcha: true },
  vouches: { channelId: null, nextId: 1, byUser: {} },
  stock: { items: {}, panel: null, notifyRoleId: null },
});

// One JSON file, no database to install. Writes are debounced and atomic (write temp file, then rename),
// so a crash mid-write can't leave a half-written store behind.
class Store {
  constructor(file) {
    this.file = file;
    this.data = { guilds: {} };
    this.timer = null;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.guilds !== 'object' || parsed.guilds === null) {
        throw new Error('missing "guilds" object');
      }
      this.data = parsed;
    } catch (err) {
      // never overwrite the only copy of a server's data: park it next to the new file
      const backup = `${file}.broken-${Date.now()}`;
      fs.copyFileSync(file, backup);
      console.error(`Could not parse ${file} (${err.message}). Starting fresh; the old file was saved as ${backup}.`);
    }
  }

  guild(id) {
    const fresh = defaults();
    if (!this.data.guilds[id] || typeof this.data.guilds[id] !== 'object') this.data.guilds[id] = fresh;
    const g = this.data.guilds[id];
    // fill in sections added in newer versions without replacing objects callers may already hold
    for (const [key, value] of Object.entries(fresh)) {
      if (!g[key] || typeof g[key] !== 'object') g[key] = value;
      else for (const [k, v] of Object.entries(value)) if (!(k in g[key])) g[key][k] = v;
    }
    return g;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.writeNow();
      } catch (err) {
        console.error('Saving data failed:', err);
      }
    }, 200);
  }

  writeNow() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writeNow();
  }
}

module.exports = { Store };
