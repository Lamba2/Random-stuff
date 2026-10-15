// Extra fake behaviour the giveaway tests need on top of test/fakes.js: a controllable clock and timers,
// a client with a guild cache, member fetches that can disagree with the (stale) member cache,
// channel.messages.edit, and a way to simulate a bot restart.
const { Collection, PermissionFlagsBits: P } = require('discord.js');
const { makeGuild, makeCtx, command, button } = require('./fakes');
const { buildRouter } = require('../src/router');
const { Store } = require('../src/store');

const MAX_TIMER = 2 ** 31 - 1;
const MODULE = require.resolve('../src/commands/giveaway');

const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r));
};

let timerSeq = 0;

function fakeTime(start = Date.parse('2026-10-15T12:00:00Z')) {
  let now = start;
  const timers = new Map();
  const time = {
    delays: [],
    now: () => now,
    // real setTimeout silently fires after 1ms for longer delays, so fail loudly instead
    setTimer(fn, ms) {
      if (!(ms >= 0 && ms <= MAX_TIMER)) throw new Error(`timer delay ${ms} is outside setTimeout's range`);
      time.delays.push(ms);
      const id = ++timerSeq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: id => { timers.delete(id); },
    get pending() { return timers.size; },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const entry of timers) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        await next[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
  return time;
}

function apiError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function attach(w, time, ctx) {
  w.time = time;
  w.ctx = Object.assign(ctx, { now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  w.mod = require(MODULE);
  w.route = buildRouter([w.mod]);
}

function world() {
  const guild = makeGuild();
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) }, users: { send: async () => {} } };
  guild.client = client;

  // Discord's view of who is in the server, versus the bot's member cache, which the Guilds intent never updates.
  const present = new Map();
  guild.members.cache = new Collection();
  guild.members.fetchCalls = [];
  guild.members.fetch = async opts => {
    guild.members.fetchCalls.push(opts);
    if (guild.members.gate) await guild.members.gate;
    if (guild.members.failFetch) throw new Error('Service Unavailable');
    const m = present.get(typeof opts === 'string' ? opts : opts.user);
    if (!m) throw apiError(10007, 'Unknown Member');
    return m;
  };
  const makeChannel = guild.textChannel;
  guild.textChannel = (name, opts) => {
    const ch = makeChannel(name, opts);
    ch.messages.edit = async (id, payload) => (await ch.messages.fetch(id)).edit(payload);
    return ch;
  };

  const w = { guild, client, present };
  attach(w, fakeTime(), makeCtx());
  w.member = (name, opts) => {
    const m = guild.member(name, opts);
    present.set(m.id, m);
    guild.members.cache.set(m.id, m);
    return m;
  };
  w.leave = m => present.delete(m.id); // stays in the stale cache
  w.general = guild.textChannel('general');
  w.admin = w.member('admin', { perms: P.ManageGuild });

  w.run = async i => {
    i.client = client;
    await w.route(i, w.ctx);
    await settle();
    return i;
  };
  w.cmd = (member, subcommand, options = {}, channel = w.general) =>
    w.run(command({ guild, member, channel, commandName: 'giveaway', subcommand, options }));
  w.press = (member, message) =>
    w.run(button({ guild, member, channel: message.channel, customId: 'giveaway:join', message }));
  w.gw = id => w.ctx.store.guild(guild.id).giveaways?.byMessage[id];
  w.start = async (options = {}) => {
    const channel = options.channel ?? w.general;
    const before = channel.history.length;
    const i = await w.cmd(w.admin, 'start', { prize: 'Nitro', duration: '1h', ...options });
    const message = channel.history.length > before ? channel.history.at(-1) : null;
    return { i, message, gw: message && w.gw(message.id) };
  };
  return w;
}

// Simulates the process stopping and starting again: data is reloaded from disk, the module's in-memory
// state is fresh, the old timers are gone, and Discord (guild, channels, messages) is unchanged.
async function restart(w, at = w.time.now()) {
  w.ctx.store.flush();
  const { store, ...rest } = w.ctx;
  delete require.cache[MODULE];
  attach(w, fakeTime(at), { ...rest, store: new Store(store.file) });
  await w.mod.onReady(w.client, w.ctx);
  await settle();
  return w;
}

async function quiet(fn) {
  const orig = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return logged;
}

const embedOf = payload => (payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0]);
const lastEdit = message => message.edits.at(-1);
const unix = ms => Math.floor(ms / 1000);

module.exports = { world, restart, fakeTime, quiet, settle, embedOf, lastEdit, unix, MAX_TIMER };
