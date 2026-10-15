const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { makeGuild, command, button, modal, lastText, isEphemeral, makeCtx } = require('./fakes');
const { buildRouter } = require('../src/router');
const { commands } = require('../src/commands');

const route = buildRouter(commands);

function world() {
  const ctx = makeCtx();
  const guild = makeGuild({ botRolePosition: 10 });
  return {
    ctx, guild,
    general: guild.textChannel('general'),
    admin: guild.member('admin', { perms: P.ManageGuild }),
    alice: guild.member('alice'),
    bob: guild.member('bob'),
  };
}

// ---------- verify ----------

test('verify setup refuses a role above the bot', async () => {
  const w = world();
  const high = w.guild.makeRole('Owner', 50);
  const i = command({ guild: w.guild, member: w.admin, channel: w.general, commandName: 'verify', subcommand: 'setup', options: { channel: w.general, role: high } });
  await route(i, w.ctx);
  assert.match(lastText(i), /has to be above \*\*Owner\*\*/);
  assert.equal(w.ctx.store.guild(w.guild.id).verify.roleId, null);
});

test('verify: captcha flow, wrong then right answer', async () => {
  const w = world();
  const member = w.guild.makeRole('Member', 3);
  const setup = command({ guild: w.guild, member: w.admin, channel: w.general, commandName: 'verify', subcommand: 'setup', options: { channel: w.general, role: member } });
  await route(setup, w.ctx);
  assert.match(lastText(setup), /Captcha is \*\*on\*\*/);
  assert.equal(w.general.sent[0].components[0].toJSON().components[0].custom_id, 'verify:start');

  const start = button({ guild: w.guild, member: w.alice, channel: w.general, customId: 'verify:start' });
  await route(start, w.ctx);
  const [kind, shown] = start.calls[0];
  assert.equal(kind, 'showModal');
  const json = shown.toJSON();
  const [, , a, b] = json.custom_id.split(':');
  assert.equal(json.components[0].label, `What is ${a} + ${b}?`);

  const wrong = modal({ guild: w.guild, member: w.alice, channel: w.general, customId: json.custom_id, fields: { answer: String(Number(a) + Number(b) + 1) } });
  await route(wrong, w.ctx);
  assert.match(lastText(wrong), /not right/);
  assert.equal(w.alice.roles.cache.has(member.id), false);

  const junk = modal({ guild: w.guild, member: w.alice, channel: w.general, customId: json.custom_id, fields: { answer: '1e1' } });
  await route(junk, w.ctx);
  assert.match(lastText(junk), /not right/);

  const right = modal({ guild: w.guild, member: w.alice, channel: w.general, customId: json.custom_id, fields: { answer: ` ${Number(a) + Number(b)} ` } });
  await route(right, w.ctx);
  assert.match(lastText(right), /verified/);
  assert.ok(isEphemeral(right.calls[0][1]));
  assert.ok(w.alice.roles.cache.has(member.id));

  const again = button({ guild: w.guild, member: w.alice, channel: w.general, customId: 'verify:start' });
  await route(again, w.ctx);
  assert.match(lastText(again), /already verified/);
});

test('verify without captcha grants straight away; not-set-up is explained', async () => {
  const w = world();
  const none = button({ guild: w.guild, member: w.alice, channel: w.general, customId: 'verify:start' });
  await route(none, w.ctx);
  assert.match(lastText(none), /not set up/);

  const member = w.guild.makeRole('Member', 3);
  await route(command({ guild: w.guild, member: w.admin, channel: w.general, commandName: 'verify', subcommand: 'setup', options: { channel: w.general, role: member, captcha: false } }), w.ctx);
  const go = button({ guild: w.guild, member: w.alice, channel: w.general, customId: 'verify:start' });
  await route(go, w.ctx);
  assert.ok(w.alice.roles.cache.has(member.id));
});

test('verify reports a role that became unassignable after setup', async () => {
  const w = world();
  const member = w.guild.makeRole('Member', 3);
  await route(command({ guild: w.guild, member: w.admin, channel: w.general, commandName: 'verify', subcommand: 'setup', options: { channel: w.general, role: member, captcha: false } }), w.ctx);
  member.position = 99; // someone dragged it above the bot
  const go = button({ guild: w.guild, member: w.alice, channel: w.general, customId: 'verify:start' });
  await route(go, w.ctx);
  assert.match(lastText(go), /couldn't verify you/);
  assert.equal(w.alice.roles.cache.has(member.id), false);
});

// ---------- roles ----------

test('role panel refuses managed roles and dedupes', async () => {
  const w = world();
  const bot = w.guild.makeRole('SomeBot', 2, { managed: true });
  const bad = command({ guild: w.guild, member: w.admin, channel: w.general, commandName: 'roles', subcommand: 'panel', options: { channel: w.general, role1: bot } });
  await route(bad, w.ctx);
  assert.match(lastText(bad), /belongs to a bot/);
  assert.equal(w.general.sent.length, 0);

  const red = w.guild.makeRole('Red', 2);
  const blue = w.guild.makeRole('Blue', 3);
  const ok = command({ guild: w.guild, member: w.admin, channel: w.general, commandName: 'roles', subcommand: 'panel', options: { channel: w.general, role1: red, role2: blue, role3: red, title: 'Colors' } });
  await route(ok, w.ctx);
  const msg = w.general.sent[0];
  const ids = msg.components[0].toJSON().components.map(c => c.custom_id);
  assert.deepEqual(ids, [`roles:toggle:${red.id}`, `roles:toggle:${blue.id}`]);
  assert.equal(msg.embeds[0].toJSON().title, 'Colors');
  assert.match(lastText(ok), /2 roles/);
});

test('role buttons toggle on and off', async () => {
  const w = world();
  const red = w.guild.makeRole('Red', 2);
  const press = () => {
    const i = button({ guild: w.guild, member: w.alice, channel: w.general, customId: `roles:toggle:${red.id}` });
    return route(i, w.ctx).then(() => i);
  };
  assert.match(lastText(await press()), /Added/);
  assert.ok(w.alice.roles.cache.has(red.id));
  assert.match(lastText(await press()), /Removed/);
  assert.equal(w.alice.roles.cache.has(red.id), false);
});

test('role button for a deleted role explains instead of crashing', async () => {
  const w = world();
  const i = button({ guild: w.guild, member: w.alice, channel: w.general, customId: 'roles:toggle:123' });
  await route(i, w.ctx);
  assert.match(lastText(i), /no longer exists/);
});

// ---------- vouch ----------

const vouch = (w, member, options, channel = w.general) =>
  command({ guild: w.guild, member, channel, commandName: 'vouch', subcommand: 'give', options });

test('vouch: no self, no bots, 24h cooldown per pair', async () => {
  const w = world();
  const self = vouch(w, w.alice, { user: w.alice.user, rating: 5, comment: 'me' });
  await route(self, w.ctx);
  assert.match(lastText(self), /yourself/);

  const botv = vouch(w, w.alice, { user: w.guild.botUser, rating: 5, comment: 'bot' });
  await route(botv, w.ctx);
  assert.match(lastText(botv), /bot/);

  const first = vouch(w, w.alice, { user: w.bob.user, rating: 5, comment: 'fast   and\nfriendly' });
  await route(first, w.ctx);
  const embed = first.calls[0][1].embeds[0].toJSON();
  assert.match(embed.description, /★★★★★\n> fast and friendly/);
  assert.match(embed.footer.text, /Vouch #1/);

  const again = vouch(w, w.alice, { user: w.bob.user, rating: 4, comment: 'again' });
  await route(again, w.ctx);
  assert.match(lastText(again), /last 24 hours/);
  assert.equal(w.ctx.store.guild(w.guild.id).vouches.byUser[w.bob.id].length, 1);
});

test('vouch: dedicated channel, view stats, admin remove', async () => {
  const w = world();
  const vouchChannel = w.guild.textChannel('vouches');
  const notAdmin = command({ guild: w.guild, member: w.alice, channel: w.general, commandName: 'vouch', subcommand: 'channel', options: { channel: vouchChannel } });
  await route(notAdmin, w.ctx);
  assert.match(lastText(notAdmin), /Manage Server/);

  await route(command({ guild: w.guild, member: w.admin, channel: w.general, commandName: 'vouch', subcommand: 'channel', options: { channel: vouchChannel } }), w.ctx);
  const v1 = vouch(w, w.alice, { user: w.bob.user, rating: 5, comment: 'great' });
  await route(v1, w.ctx);
  assert.match(lastText(v1), /posted in/);
  assert.equal(vouchChannel.sent.length, 1);
  const carol = w.guild.member('carol');
  await route(vouch(w, carol, { user: w.bob.user, rating: 4, comment: 'good' }), w.ctx);

  const view = command({ guild: w.guild, member: w.alice, channel: w.general, commandName: 'vouch', subcommand: 'view', options: { user: w.bob.user } });
  await route(view, w.ctx);
  const desc = view.calls[0][1].embeds[0].toJSON().description;
  assert.match(desc, /\*\*2\*\* vouches · \*\*4\.5\*\*/);
  assert.ok(desc.indexOf('#2') < desc.indexOf('#1'), 'newest first');

  const rm = command({ guild: w.guild, member: w.admin, channel: w.general, commandName: 'vouch', subcommand: 'remove', options: { user: w.bob.user, number: 1 } });
  await route(rm, w.ctx);
  assert.match(lastText(rm), /Removed vouch #1/);
  const missing = command({ guild: w.guild, member: w.admin, channel: w.general, commandName: 'vouch', subcommand: 'remove', options: { user: w.bob.user, number: 1 } });
  await route(missing, w.ctx);
  assert.match(lastText(missing), /no vouch #1/);

  const empty = command({ guild: w.guild, member: w.alice, channel: w.general, commandName: 'vouch', subcommand: 'view', options: { user: w.alice.user } });
  await route(empty, w.ctx);
  assert.match(lastText(empty), /no vouches yet/);
});

// ---------- stock ----------

const stock = (w, member, subcommand, options = {}) =>
  command({ guild: w.guild, member, channel: w.general, commandName: 'stock', subcommand, options });

test('stock: members can view but not edit', async () => {
  const w = world();
  const set = stock(w, w.alice, 'set', { item: 'Sword', quantity: 3 });
  await route(set, w.ctx);
  assert.match(lastText(set), /Manage Server/);
  const view = stock(w, w.alice, 'view');
  await route(view, w.ctx);
  assert.ok(isEphemeral(view.calls[0][1]));
  assert.equal(view.calls[0][1].embeds[0].toJSON().description, 'Nothing listed yet.');
});

test('stock: set, live panel edits, restock ping, remove', async () => {
  const w = world();
  const shop = w.guild.textChannel('shop');
  const pingRole = w.guild.makeRole('Restock', 2);
  await route(stock(w, w.admin, 'set', { item: '  Blox  Fruit ', quantity: 0, price: '$5' }), w.ctx);
  const items = w.ctx.store.guild(w.guild.id).stock.items;
  assert.deepEqual(items['blox fruit'], { name: 'Blox Fruit', quantity: 0, price: '$5' });

  await route(stock(w, w.admin, 'panel', { channel: shop, restock_ping: pingRole }), w.ctx);
  const panelMsg = shop.history[0];
  assert.match(panelMsg.embeds[0].description, /🔴 \*\*Blox Fruit\*\*: sold out · \$5/);

  await route(stock(w, w.admin, 'set', { item: 'blox fruit', quantity: 12 }), w.ctx);
  assert.equal(items['blox fruit'].price, '$5', 'price kept when not given');
  const edited = panelMsg.edits.at(-1).embeds[0].toJSON().description;
  assert.match(edited, /🟢 \*\*blox fruit\*\*: 12 in stock · \$5/);
  const ping = shop.sent.at(-1);
  assert.match(ping.content, new RegExp(`<@&${pingRole.id}>`));
  assert.deepEqual(ping.allowedMentions, { roles: [pingRole.id] });

  const pingsBefore = shop.sent.length;
  await route(stock(w, w.admin, 'set', { item: 'blox fruit', quantity: 11 }), w.ctx);
  assert.equal(shop.sent.length, pingsBefore, 'no ping when it was already in stock');

  const rm = stock(w, w.admin, 'remove', { item: 'BLOX FRUIT' });
  await route(rm, w.ctx);
  assert.match(lastText(rm), /Removed/);
  assert.equal(panelMsg.edits.at(-1).embeds[0].toJSON().description, 'Nothing listed yet.');
});

test('stock: a deleted panel is forgotten, a re-posted panel replaces the old one', async () => {
  const w = world();
  const shop = w.guild.textChannel('shop');
  await route(stock(w, w.admin, 'panel', { channel: shop }), w.ctx);
  const first = shop.history[0].id;
  await route(stock(w, w.admin, 'panel', { channel: shop }), w.ctx);
  assert.ok(!shop.history.some(m => m.id === first), 'old panel deleted');

  shop.history.length = 0; // someone deleted the panel by hand
  await route(stock(w, w.admin, 'set', { item: 'Gem', quantity: 1 }), w.ctx);
  assert.equal(w.ctx.store.guild(w.guild.id).stock.panel, null);
});

test('stock list is capped to fit in one embed', () => {
  const { stockEmbed } = require('../src/commands/stock');
  const items = {};
  for (let i = 0; i < 300; i++) items[`item ${i}`] = { name: `Item number ${String(i).padStart(3, '0')} with a long name`, quantity: i, price: '$1' };
  const desc = stockEmbed(items, 0).toJSON().description;
  assert.ok(desc.length <= 4096, `description is ${desc.length} chars`);
  assert.match(desc, /…and \d+ more$/);
});

// ---------- roll / help / router ----------

test('roll replies publicly and rejects nonsense', async () => {
  const w = world();
  const ok = command({ guild: w.guild, member: w.alice, channel: w.general, commandName: 'roll', options: { dice: '3d6+2' } });
  await route(ok, w.ctx);
  assert.match(lastText(ok), /rolled \*\*3d6\+2\*\* → \[\d, \d, \d\] \+ 2 = \*\*\d+\*\*/);
  assert.equal(isEphemeral(ok.calls[0][1]), false);
  const bad = command({ guild: w.guild, member: w.alice, channel: w.general, commandName: 'roll', options: { dice: '999d6' } });
  await route(bad, w.ctx);
  assert.ok(isEphemeral(bad.calls[0][1]));
  const plain = command({ guild: w.guild, member: w.alice, channel: w.general, commandName: 'roll', options: {} });
  await route(plain, w.ctx);
  assert.match(lastText(plain), /rolled \*\*1d6\*\* = \*\*[1-6]\*\*/);
});

test('help lists every command', async () => {
  const w = world();
  const i = command({ guild: w.guild, member: w.alice, channel: w.general, commandName: 'help' });
  await route(i, w.ctx);
  const text = JSON.stringify(i.calls[0][1].embeds[0].toJSON());
  for (const c of commands.filter(c => c.data.name !== 'help')) assert.ok(text.includes(`/${c.data.name}`), `help mentions /${c.data.name}`);
});

test('router ignores unknown ids and turns crashes into a polite message', async () => {
  const w = world();
  const unknown = button({ guild: w.guild, member: w.alice, channel: w.general, customId: 'nope:thing' });
  await route(unknown, w.ctx);
  assert.equal(unknown.calls.length, 0);

  const orig = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const boom = { data: { name: 'boom' }, execute: async i => { await i.deferReply(); throw new Error('kaboom'); } };
    const r = buildRouter([boom]);
    const i = command({ guild: w.guild, member: w.alice, channel: w.general, commandName: 'boom' });
    await r(i, w.ctx);
    assert.equal(i.calls.at(-1)[0], 'editReply');
    assert.match(lastText(i), /Something went wrong/);
    assert.ok(logged.some(l => l.includes('kaboom')));
  } finally {
    console.error = orig;
  }
});

test('commands used outside a cached guild are refused', async () => {
  const w = world();
  const i = command({ guild: w.guild, member: w.alice, channel: w.general, commandName: 'help' });
  i.cached = false;
  await route(i, w.ctx);
  assert.match(lastText(i), /inside a server/);
});
