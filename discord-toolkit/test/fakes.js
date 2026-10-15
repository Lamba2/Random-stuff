// Minimal stand-ins for the discord.js objects the bot touches. They enforce the interaction
// lifecycle rules the real API enforces (one initial response, update/showModal only first, etc.)
// so double-reply bugs fail tests instead of failing in production.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { Collection, PermissionsBitField, ChannelType } = require('discord.js');
const { Store } = require('../src/store');

let seq = 1_000_000n;
const nextId = () => String(seq++);
let clock = Date.parse('2026-10-15T12:00:00Z');

function makeUser(username, extra = {}) {
  return {
    id: nextId(), username, tag: username, bot: false, ...extra,
    toString() { return `<@${this.id}>`; },
    displayAvatarURL: () => 'https://cdn.example/avatar.png',
  };
}

function makeMessage(channel, payload, author) {
  const p = typeof payload === 'string' ? { content: payload } : payload;
  const msg = {
    id: nextId(), channel, author, payload: p,
    content: p.content ?? '',
    embeds: (p.embeds || []).map(e => (e.toJSON ? e.toJSON() : e)),
    attachments: new Collection(),
    createdTimestamp: clock++,
    edits: [],
    edit: async next => { msg.edits.push(next); return msg; },
  };
  return msg;
}

function unknownMessage() {
  const err = new Error('Unknown Message');
  err.code = 10008;
  return err;
}

function makeTextChannel(guild, name, opts = {}) {
  const ch = {
    id: nextId(), name, guild, type: opts.type ?? ChannelType.GuildText,
    parentId: opts.parent ?? null, overwrites: opts.permissionOverwrites || [], topic: opts.topic,
    history: [], deleted: false, botPerms: opts.botPerms ?? PermissionsBitField.All,
    isTextBased: () => (opts.type ?? ChannelType.GuildText) === ChannelType.GuildText,
    toString() { return `<#${this.id}>`; },
    permissionsFor: () => new PermissionsBitField(ch.botPerms),
    send: async payload => {
      if (ch.deleted) throw new Error('Unknown Channel');
      if (ch.failSend) throw new Error('Missing Access');
      const m = makeMessage(ch, payload, guild.botUser);
      ch.history.push(m);
      return m;
    },
    post(author, content, extra = {}) {
      const m = makeMessage(ch, { content, ...extra }, author);
      ch.history.push(m);
      return m;
    },
    get sent() { return ch.history.filter(m => m.author === guild.botUser).map(m => m.payload); },
    messages: {
      fetch: async arg => {
        if (typeof arg === 'string') {
          const m = ch.history.find(x => x.id === arg);
          if (!m) throw unknownMessage();
          return m;
        }
        const { limit = 50, before, after } = arg || {};
        ch.fetchCalls = (ch.fetchCalls || 0) + 1;
        let page;
        if (after !== undefined) {
          // the messages right after `after`
          page = ch.history.filter(m => BigInt(m.id) > BigInt(after)).slice(0, limit).reverse();
        } else {
          const older = ch.history.filter(m => !before || BigInt(m.id) < BigInt(before));
          page = older.slice(-limit).reverse(); // API order: newest first
        }
        return new Collection(page.map(m => [m.id, m]));
      },
      delete: async mid => {
        const i = ch.history.findIndex(m => m.id === mid);
        if (i === -1) throw unknownMessage();
        ch.history.splice(i, 1);
      },
    },
    permissionOverwrites: {
      edits: [], deletes: [],
      edit: async (who, options, extra) => { ch.permissionOverwrites.edits.push({ who, options, extra }); },
      delete: async (who, reason) => { ch.permissionOverwrites.deletes.push({ who, reason }); },
    },
    delete: async () => {
      if (ch.failDelete) throw new Error('Service Unavailable');
      ch.deleted = true;
      guild.channels.cache.delete(ch.id);
    },
  };
  guild.channels.cache.set(ch.id, ch);
  return ch;
}

function makeMember(guild, user, roles = [], perms = 0n) {
  const cache = new Collection(roles.map(r => [r.id, r]));
  return {
    id: user.id, user, guild,
    permissions: new PermissionsBitField(perms),
    roles: {
      cache,
      get highest() {
        return [...cache.values()].reduce((a, b) => (b.position > a.position ? b : a), guild.roles.everyone);
      },
      add: async role => { cache.set(role.id, role); },
      remove: async role => { cache.delete(role.id); },
    },
    toString() { return `<@${user.id}>`; },
  };
}

function makeGuild({ botPerms = PermissionsBitField.All, botRolePosition = 10 } = {}) {
  const guild = { id: nextId(), name: 'Test Server' };
  const roles = new Collection();
  guild.makeRole = (name, position, extra = {}) => {
    const role = {
      id: extra.id || nextId(), name, position, managed: false, guild, ...extra,
      comparePositionTo(other) { return this.position - other.position; },
      toString() { return `<@&${this.id}>`; },
    };
    roles.set(role.id, role);
    return role;
  };
  guild.roles = { cache: roles };
  guild.roles.everyone = guild.makeRole('@everyone', 0, { id: guild.id });
  guild.channels = {
    cache: new Collection(),
    createCalls: [],
    failCreate: false,
    create: async opts => {
      guild.channels.createCalls.push(opts);
      if (guild.channels.failCreate) throw new Error('Missing Permissions');
      return makeTextChannel(guild, opts.name, opts);
    },
  };
  guild.botUser = makeUser('ToolkitBot', { bot: true });
  const botRole = guild.makeRole('ToolkitBot', botRolePosition, { managed: true });
  guild.me = makeMember(guild, guild.botUser, [botRole], botPerms);
  guild.members = { me: guild.me, fetchMe: async () => guild.me };
  guild.textChannel = (name, opts) => makeTextChannel(guild, name, opts);
  guild.member = (username, { roles: r = [], perms = 0n } = {}) => makeMember(guild, makeUser(username), r, perms);
  guild.owner = guild.member('owner', { perms: PermissionsBitField.All });
  guild.ownerId = guild.owner.id;
  return guild;
}

function makeInteraction({ type, guild, member, channel = null, commandName, subcommand, options = {}, customId, fields = {}, values = [], message = null }) {
  const calls = [];
  const dms = [];
  const get = (name, required) => {
    const v = options[name];
    if (v === undefined && required) throw new Error(`required option "${name}" not provided`);
    return v ?? null;
  };
  const i = {
    guild, guildId: guild.id, member, user: member.user, channel, channelId: channel?.id ?? null,
    commandName, customId, values, message, memberPermissions: member.permissions,
    replied: false, deferred: false, calls, dms,
    client: { users: { send: async (userId, payload) => { if (i.dmFails) throw new Error('Cannot send messages to this user'); dms.push({ userId, payload }); } } },
    isChatInputCommand: () => type === 'command',
    isButton: () => type === 'button',
    isStringSelectMenu: () => type === 'select',
    isModalSubmit: () => type === 'modal',
    inCachedGuild: () => i.cached !== false,
    options: {
      getSubcommand: () => subcommand,
      getChannel: get, getRole: get, getUser: get, getInteger: get, getString: get, getBoolean: get,
    },
    fields: { getTextInputValue: name => { if (!(name in fields)) throw new Error(`no field ${name}`); return fields[name]; } },
    reply: async p => {
      if (i.replied || i.deferred) throw new Error('InteractionAlreadyReplied');
      i.replied = true; calls.push(['reply', p]);
    },
    deferReply: async p => {
      if (i.replied || i.deferred) throw new Error('InteractionAlreadyReplied');
      i.deferred = true; calls.push(['deferReply', p]);
    },
    editReply: async p => {
      if (!i.replied && !i.deferred) throw new Error('InteractionNotReplied');
      i.replied = true; calls.push(['editReply', p]);
    },
    followUp: async p => {
      if (!i.replied && !i.deferred) throw new Error('InteractionNotReplied');
      if (i.followUpFails) throw new Error('Unknown Webhook');
      calls.push(['followUp', p]);
    },
    update: async p => {
      if (type !== 'button' && type !== 'select') throw new Error('update() is only for component interactions');
      if (i.replied || i.deferred) throw new Error('InteractionAlreadyReplied');
      i.replied = true; calls.push(['update', p]);
    },
    deferUpdate: async () => {
      if (type !== 'button' && type !== 'select') throw new Error('deferUpdate() is only for component interactions');
      if (i.replied || i.deferred) throw new Error('InteractionAlreadyReplied');
      i.deferred = true; calls.push(['deferUpdate']);
    },
    showModal: async m => {
      if (i.replied || i.deferred) throw new Error('InteractionAlreadyReplied');
      i.replied = true; calls.push(['showModal', m]);
    },
  };
  return i;
}

const command = (o) => makeInteraction({ type: 'command', ...o });
const button = (o) => makeInteraction({ type: 'button', ...o });
const modal = (o) => makeInteraction({ type: 'modal', ...o });
const select = (o) => makeInteraction({ type: 'select', ...o });

// The last thing the user saw, flattened to text for easy assertions.
function lastText(i) {
  const [, p] = i.calls[i.calls.length - 1] || [];
  if (!p) return '';
  return typeof p === 'string' ? p : p.content ?? '';
}
const isEphemeral = p => Boolean(p && typeof p === 'object' && (p.flags & 64));

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-test-'));
  return { store: new Store(path.join(dir, 'store.json')), dir };
}

function makeCtx() {
  const { store, dir } = tempStore();
  return { store, color: 0x5865f2, ticketDeleteDelayMs: 0, dir };
}

const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

module.exports = { makeGuild, makeUser, makeMember, makeTextChannel, makeInteraction, command, button, modal, select, lastText, isEphemeral, tempStore, makeCtx, tick, PermissionsBitField };
