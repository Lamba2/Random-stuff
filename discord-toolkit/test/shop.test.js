const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P, OverwriteType } = require('discord.js');
const { makeGuild, command, button, select, lastText, isEphemeral, makeCtx, tick } = require('./fakes');
const { Store } = require('../src/store');
const { buildRouter } = require('../src/router');
const shopCmd = require('../src/commands/shop');
const ticket = require('../src/commands/ticket');
const stock = require('../src/commands/stock');

const route = buildRouter([shopCmd, ticket, stock]);

function world() {
  const ctx = makeCtx();
  const guild = makeGuild();
  const staffRole = guild.makeRole('Staff', 5);
  return {
    ctx, guild, staffRole,
    general: guild.textChannel('general'),
    shopChannel: guild.textChannel('shop'),
    logs: guild.textChannel('ticket-logs'),
    admin: guild.member('admin', { perms: P.ManageGuild }),
    staff: guild.member('helper', { roles: [staffRole] }),
    alice: guild.member('alice'),
    bob: guild.member('bob'),
  };
}

const run = async (w, i) => { await route(i, w.ctx); return i; };
const shop = (w, member, subcommand, options = {}) =>
  run(w, command({ guild: w.guild, member, channel: w.general, commandName: 'shop', subcommand, options }));
const stockCmd = (w, subcommand, options = {}) =>
  run(w, command({ guild: w.guild, member: w.admin, channel: w.general, commandName: 'stock', subcommand, options }));
const ticketSetup = w => run(w, command({
  guild: w.guild, member: w.admin, channel: w.general, commandName: 'ticket', subcommand: 'setup',
  options: { channel: w.general, staff_role: w.staffRole, log_channel: w.logs },
}));
const pickItem = (w, member, value) => select({ guild: w.guild, member, channel: w.shopChannel, customId: 'shop:order', values: [value] });
const pick = (w, member, value) => run(w, pickItem(w, member, value));

const section = w => w.ctx.store.guild(w.guild.id).shop;
const orderChannels = w => [...w.guild.channels.cache.values()].filter(c => c.name.startsWith('order-'));
const orderMessage = ch => ch.history.find(m => m.payload.components?.length);
const ids = payload => payload.components[0].toJSON().components.map(c => c.custom_id);
const pressItem = (w, member, ch, action) => {
  const msg = orderMessage(ch);
  const customId = ids(msg.payload).find(id => id.startsWith(`shop:${action}`));
  return button({ guild: w.guild, member, channel: ch, customId, message: msg });
};
const press = (w, member, ch, action) => run(w, pressItem(w, member, ch, action));
const json = e => (e.toJSON ? e.toJSON() : e);
// the panel as members currently see it
const panelView = w => {
  const msg = w.shopChannel.history.find(m => m.id === section(w).panel.messageId);
  const p = msg.edits.at(-1) ?? msg.payload;
  return { embed: json(p.embeds[0]), menu: p.components[0]?.toJSON().components[0] };
};
const quiet = async fn => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

async function ready(w, { quantity = 2 } = {}) {
  await ticketSetup(w);
  await stockCmd(w, 'set', { item: 'Netflix Account', quantity });
  await shop(w, w.admin, 'payment', { text: 'PayPal Goods & Services to pay@example.com' });
  await shop(w, w.admin, 'add', { name: 'Netflix 1 Month', price: '$5', description: 'Private profile, 30 days', stock_item: 'netflix account' });
  await shop(w, w.admin, 'panel', { channel: w.shopChannel });
}

test('shop: members can list but not manage', async () => {
  const w = world();
  for (const [sub, options] of [
    ['add', { name: 'Thing', price: '$1' }], ['remove', { name: 'Thing' }], ['payment', { text: 'x' }],
    ['panel', { channel: w.shopChannel }], ['orders', {}], ['deliver', { order: 1 }], ['cancel', { order: 1 }],
  ]) {
    const i = await shop(w, w.alice, sub, options);
    assert.match(lastText(i), /Manage Server/, sub);
  }
  assert.equal(w.shopChannel.sent.length, 0);
  const list = await shop(w, w.alice, 'list');
  assert.ok(isEphemeral(list.calls[0][1]));
  assert.equal(json(list.calls[0][1].embeds[0]).description, 'Nothing for sale right now.');
  assert.equal(list.calls[0][1].content, undefined, 'no admin setup notes for members');
});

test('shop add validates image links, stock links and the 25 product cap', async () => {
  const w = world();
  for (const bad of ['javascript:alert(1)', 'ftp://files.example/a.png', 'not a link', 'www.example.com/a.png']) {
    const i = await shop(w, w.admin, 'add', { name: 'Thing', price: '$1', image_url: bad });
    assert.match(lastText(i), /https:\/\//, bad);
  }
  const noStock = await shop(w, w.admin, 'add', { name: 'Thing', price: '$1', stock_item: 'ghost' });
  assert.match(lastText(noStock), /no \/stock item called \*\*ghost\*\*/);
  const blank = await shop(w, w.admin, 'add', { name: '   ', price: '$1' });
  assert.match(lastText(blank), /name and a price/);
  assert.deepEqual(section(w).products, {});

  for (let n = 1; n <= 25; n++) await shop(w, w.admin, 'add', { name: `Item ${n}`, price: '$1' });
  const full = await shop(w, w.admin, 'add', { name: 'Item 26', price: '$1' });
  assert.match(lastText(full), /already has 25 products/);
  const update = await shop(w, w.admin, 'add', { name: 'ITEM 3', price: '$2' });
  assert.match(lastText(update), /Updated \*\*ITEM 3\*\* at \$2/);
  assert.equal(Object.keys(section(w).products).length, 25);
});

test('shop add: updating keeps options left out, "none" clears them', async () => {
  const w = world();
  await stockCmd(w, 'set', { item: 'Gems', quantity: 4 });
  const first = await shop(w, w.admin, 'add', { name: '  Gem   Pack ', price: '$3', description: 'Shiny', image_url: 'https://cdn.example/gem.png', stock_item: 'GEMS' });
  assert.match(lastText(first), /Added \*\*Gem Pack\*\* at \$3\. It sells from \*\*Gems\*\* in \/stock \(4 left\)/);
  assert.match(lastText(first), /\/ticket setup/, 'setup notes shown');
  assert.deepEqual(section(w).products['gem pack'], {
    name: 'Gem Pack', price: '$3', description: 'Shiny', imageUrl: 'https://cdn.example/gem.png', stockKey: 'gems',
  });
  const second = await shop(w, w.admin, 'add', { name: 'gem pack', price: '$4' });
  assert.match(lastText(second), /kept their old value/);
  assert.deepEqual(section(w).products['gem pack'], {
    name: 'gem pack', price: '$4', description: 'Shiny', imageUrl: 'https://cdn.example/gem.png', stockKey: 'gems',
  });
  await shop(w, w.admin, 'add', { name: 'gem pack', price: '$4', description: 'none', image_url: 'NONE', stock_item: 'none' });
  assert.deepEqual(section(w).products['gem pack'], { name: 'gem pack', price: '$4', description: null, imageUrl: null, stockKey: null });
});

test('shop panel shows price and stock, with a menu to order from', async () => {
  const w = world();
  const empty = await shop(w, w.admin, 'panel', { channel: w.shopChannel });
  assert.match(lastText(empty), /Add a product/);
  await stockCmd(w, 'set', { item: 'Robux', quantity: 0 });
  await shop(w, w.admin, 'add', { name: 'Robux 1k', price: '$10', stock_item: 'robux' });
  await shop(w, w.admin, 'add', { name: 'Logo design', price: '$25', description: 'Custom logo in 3 days' });

  const noPerms = w.guild.textChannel('locked', { botPerms: P.ViewChannel | P.SendMessages });
  const refused = await shop(w, w.admin, 'panel', { channel: noPerms });
  assert.match(lastText(refused), /Embed Links/);

  const posted = await shop(w, w.admin, 'panel', { channel: w.shopChannel });
  assert.match(lastText(posted), /Shop panel posted/);
  assert.match(lastText(posted), /\/ticket setup/, 'warns that orders need tickets');
  const { embed, menu } = panelView(w);
  assert.deepEqual(embed.fields.map(f => f.name), ['Logo design · $25', 'Robux 1k · $10']);
  assert.equal(embed.fields[0].value, 'Custom logo in 3 days\n🟢 Available');
  assert.equal(embed.fields[1].value, '🔴 Sold out');
  assert.equal(menu.custom_id, 'shop:order');
  assert.deepEqual(menu.options.map(o => [o.value, o.description]), [['logo design', '$25 · Available'], ['robux 1k', '$10 · Sold out']]);
});

test('25 products with the longest allowed text still fit in one panel message', async () => {
  const w = world();
  for (let n = 0; n < 25; n++) {
    await shop(w, w.admin, 'add', {
      name: `${String(n).padStart(2, '0')} ${'N'.repeat(77)}`, price: 'P'.repeat(40), description: 'D'.repeat(300),
    });
  }
  await shop(w, w.admin, 'panel', { channel: w.shopChannel });
  const { embed, menu } = panelView(w);
  const total = embed.title.length + embed.description.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(total <= 6000, `panel is ${total} characters`);
  assert.equal(embed.fields.length, 25);
  assert.ok(embed.fields.every(f => f.name.length <= 256 && f.value.length <= 1024));
  assert.ok(embed.fields.every(f => f.value.includes('DDD')), 'descriptions shortened, not dropped');
  assert.equal(menu.options.length, 25);
  assert.ok(menu.options.every(o => o.label.length <= 100 && o.value.length <= 100 && o.description.length <= 100));
});

test('add and remove keep the newest panel up to date; a deleted panel is forgotten', async () => {
  const w = world();
  await shop(w, w.admin, 'add', { name: 'Logo', price: '$25' });
  await shop(w, w.admin, 'panel', { channel: w.shopChannel });
  const first = section(w).panel.messageId;
  await shop(w, w.admin, 'panel', { channel: w.shopChannel });
  assert.ok(!w.shopChannel.history.some(m => m.id === first), 'old panel deleted');

  await shop(w, w.admin, 'add', { name: 'Banner', price: '$15' });
  assert.deepEqual(panelView(w).menu.options.map(o => o.label), ['Banner', 'Logo']);
  const rm = await shop(w, w.admin, 'remove', { name: 'LOGO' });
  assert.match(lastText(rm), /Removed \*\*Logo\*\*/);
  assert.deepEqual(panelView(w).menu.options.map(o => o.label), ['Banner']);
  const missing = await shop(w, w.admin, 'remove', { name: 'Logo' });
  assert.match(lastText(missing), /no product called/);

  await shop(w, w.admin, 'remove', { name: 'Banner' });
  assert.equal(panelView(w).embed.description, 'Nothing for sale right now.');
  assert.equal(panelView(w).menu, undefined, 'no empty menu');

  w.shopChannel.history.length = 0; // someone deleted the panel by hand
  await shop(w, w.admin, 'add', { name: 'Logo', price: '$25' });
  assert.equal(section(w).panel, null);

  await shop(w, w.admin, 'panel', { channel: w.shopChannel });
  w.shopChannel.delete();
  const add = await shop(w, w.admin, 'add', { name: 'Icon', price: '$5' });
  assert.match(lastText(add), /Added/);
  assert.equal(section(w).panel, null, 'deleted channel forgotten');
});

test('ordering before /ticket setup explains why', async () => {
  const w = world();
  await shop(w, w.admin, 'add', { name: 'Logo', price: '$25' });
  const i = await pick(w, w.alice, 'logo');
  assert.ok(isEphemeral(i.calls[0][1]));
  assert.match(lastText(i), /\/ticket setup/);
  assert.equal(orderChannels(w).length, 0);
  assert.deepEqual(section(w).orders, {});
});

test('order flow: ticket, Mark paid, Delivered, stock, vouch prompt and /shop orders', async () => {
  const w = world();
  await ready(w);
  await stockCmd(w, 'panel', { channel: w.general });
  const stockPanel = w.general.history.find(m => m.id === w.ctx.store.guild(w.guild.id).stock.panel.messageId);

  const i = await pick(w, w.alice, 'netflix 1 month');
  assert.ok(isEphemeral(i.calls[0][1]), 'deferred ephemerally');
  const [ch] = orderChannels(w);
  assert.ok(ch, 'order channel created');
  assert.equal(ch.name, 'order-0001-alice');
  assert.match(lastText(i), new RegExp(`order ticket is open: <#${ch.id}>`));
  const ow = Object.fromEntries(ch.overwrites.map(o => [o.id, o]));
  assert.deepEqual(ow[w.guild.id].deny, [P.ViewChannel]);
  assert.equal(ow[w.alice.id].type, OverwriteType.Member);
  assert.ok(ow[w.staffRole.id].allow.includes(P.SendMessages));
  assert.equal(ow[w.bob.id], undefined);

  const welcome = orderMessage(ch).payload;
  assert.deepEqual(welcome.allowedMentions, { users: [w.alice.id], roles: [w.staffRole.id] });
  const embed = json(welcome.embeds[0]);
  assert.equal(embed.title, 'Order #1');
  const field = name => embed.fields.find(f => f.name === name)?.value;
  assert.equal(field('Product'), 'Netflix 1 Month');
  assert.equal(field('Price'), '$5');
  assert.equal(field('Quantity'), '1');
  assert.equal(field('Buyer'), `<@${w.alice.id}>`);
  assert.equal(field('Details'), 'Private profile, 30 days');
  assert.equal(field('How to pay'), 'PayPal Goods & Services to pay@example.com');
  assert.deepEqual(ids(welcome), ['shop:paid:1', 'shop:deliver:1', 'ticket:close']);
  const g = w.ctx.store.guild(w.guild.id);
  assert.equal(g.tickets.open[ch.id].kind, 'order');
  assert.equal(g.tickets.open[ch.id].ownerId, w.alice.id);
  assert.equal(section(w).orders[1].status, 'open');
  assert.equal(section(w).orders[1].channelId, ch.id);
  assert.equal(w.shopChannel.history[0].edits.length > 0, true, 'panel redrawn, which also resets the menu');

  const paid = await press(w, w.staff, ch, 'paid');
  const [kind, update] = paid.calls[0];
  assert.equal(kind, 'update');
  assert.match(json(update.embeds[0]).fields.find(f => f.name === 'Status').value, new RegExp(`Paid, confirmed by <@${w.staff.id}>`));
  assert.deepEqual(update.components[0].toJSON().components.map(c => Boolean(c.disabled)), [true, false, false]);
  assert.equal(section(w).orders[1].paidBy, w.staff.id);

  const done = await press(w, w.staff, ch, 'deliver');
  assert.equal(done.calls[0][0], 'update');
  assert.match(json(done.calls[0][1].embeds[0]).fields.find(f => f.name === 'Status').value, /Delivered by/);
  assert.deepEqual(done.calls[0][1].components[0].toJSON().components.map(c => Boolean(c.disabled)), [true, true, false]);
  assert.equal(g.stock.items['netflix account'].quantity, 1);
  assert.match(lastText(done), /now has 1 left/);
  assert.ok(isEphemeral(done.calls.at(-1)[1]));
  assert.match(json(stockPanel.edits.at(-1).embeds[0]).description, /Netflix Account\*\*: 1 in stock/);
  assert.match(panelView(w).embed.fields[0].value, /1 in stock/);

  const prompt = ch.sent.at(-1);
  assert.match(prompt.content, new RegExp(`^<@${w.alice.id}> your order \\*\\*Netflix 1 Month\\*\\* was delivered by <@${w.staff.id}>`));
  assert.match(prompt.content, /\/vouch give/);
  assert.deepEqual(prompt.allowedMentions, { users: [w.alice.id] }, 'only the buyer is pinged');

  const order = section(w).orders[1];
  assert.equal(order.deliveredBy, w.staff.id);
  assert.ok(order.createdAt && order.paidAt && order.deliveredAt);

  const list = await shop(w, w.admin, 'orders');
  const desc = json(list.calls[0][1].embeds[0]).description;
  assert.match(desc, /\*\*#1\*\* Netflix 1 Month · \$5/);
  assert.match(desc, /delivered by/);
});

test('members cannot press the staff buttons', async () => {
  const w = world();
  await ready(w);
  await pick(w, w.alice, 'netflix 1 month');
  const [ch] = orderChannels(w);
  for (const [who, action] of [[w.alice, 'paid'], [w.alice, 'deliver'], [w.bob, 'deliver']]) {
    const i = await press(w, who, ch, action);
    assert.match(lastText(i), /Only staff/);
    assert.ok(isEphemeral(i.calls[0][1]));
  }
  assert.equal(section(w).orders[1].status, 'open');
  assert.equal(w.ctx.store.guild(w.guild.id).stock.items['netflix account'].quantity, 2);
  const admin = await press(w, w.admin, ch, 'paid');
  assert.equal(admin.calls[0][0], 'update', 'Manage Server counts as staff');
});

test('double clicks on Mark paid and Delivered only count once', async () => {
  const w = world();
  await ready(w);
  await pick(w, w.alice, 'netflix 1 month');
  const [ch] = orderChannels(w);
  const p = [pressItem(w, w.staff, ch, 'paid'), pressItem(w, w.admin, ch, 'paid')];
  await Promise.all(p.map(i => route(i, w.ctx)));
  assert.ok(p.some(i => /already marked order #1 as paid/.test(lastText(i))));

  const d = [pressItem(w, w.staff, ch, 'deliver'), pressItem(w, w.staff, ch, 'deliver')];
  await Promise.all(d.map(i => route(i, w.ctx)));
  assert.ok(d.some(i => /already delivered order #1/.test(lastText(i))));
  assert.equal(w.ctx.store.guild(w.guild.id).stock.items['netflix account'].quantity, 1);
  assert.equal(ch.sent.filter(m => /was delivered by/.test(m.content ?? '')).length, 1);

  const late = await press(w, w.staff, ch, 'paid');
  assert.match(lastText(late), /already delivered/);
});

test('two buyers racing for the last item: one gets it, the other is told it is reserved', async () => {
  const w = world();
  await ready(w, { quantity: 1 });
  const a = pickItem(w, w.alice, 'netflix 1 month');
  const b = pickItem(w, w.bob, 'netflix 1 month');
  await Promise.all([route(a, w.ctx), route(b, w.ctx)]);
  assert.equal(orderChannels(w).length, 1);
  assert.match(lastText(a), /order ticket is open/);
  assert.match(lastText(b), /reserved by an open order/);

  // Alice closes her ticket without paying, which frees the item for Bob
  const [ch] = orderChannels(w);
  await run(w, button({ guild: w.guild, member: w.alice, channel: ch, customId: 'ticket:confirm' }));
  await tick();
  assert.ok(ch.deleted);
  const again = await pick(w, w.bob, 'netflix 1 month');
  assert.match(lastText(again), /order ticket is open/);

  const list = await shop(w, w.admin, 'orders');
  assert.match(json(list.calls[0][1].embeds[0]).description, /#1\*\*[^\n]*\n✖️ closed without delivery/);
});

test('stock running out after the panel was drawn refuses the order and redraws the panel', async () => {
  const w = world();
  await ready(w, { quantity: 3 });
  assert.match(panelView(w).embed.fields[0].value, /3 in stock/);
  await stockCmd(w, 'set', { item: 'netflix account', quantity: 0 });
  const i = await pick(w, w.alice, 'netflix 1 month');
  assert.match(lastText(i), /sold out/);
  assert.equal(orderChannels(w).length, 0);
  assert.match(panelView(w).embed.fields[0].value, /Sold out/);

  await stockCmd(w, 'set', { item: 'netflix account', quantity: 1 }); // restocked: the stale menu still works
  const j = await pick(w, w.alice, 'netflix 1 month');
  assert.match(lastText(j), /order ticket is open/);
});

test('a product removed while an order is open can still be delivered; stale menus are refused', async () => {
  const w = world();
  await ready(w);
  await pick(w, w.alice, 'netflix 1 month');
  const [ch] = orderChannels(w);
  const rm = await shop(w, w.admin, 'remove', { name: 'netflix 1 month' });
  assert.match(lastText(rm), /1 open order for it can still be delivered/);

  const stale = await pick(w, w.bob, 'netflix 1 month');
  assert.match(lastText(stale), /isn't for sale anymore/);
  assert.equal(orderChannels(w).length, 1);

  const done = await press(w, w.staff, ch, 'deliver');
  assert.equal(done.calls[0][0], 'update');
  assert.equal(w.ctx.store.guild(w.guild.id).stock.items['netflix account'].quantity, 1);
  assert.match(ch.sent.at(-1).content, /Netflix 1 Month\*\* was delivered/);
});

test('Delivered never takes stock below 0, and a deleted stock item is reported', async () => {
  const w = world();
  await ready(w);
  await pick(w, w.alice, 'netflix 1 month');
  await pick(w, w.bob, 'netflix 1 month');
  const [first, second] = orderChannels(w);
  await stockCmd(w, 'set', { item: 'netflix account', quantity: 0 });
  const zero = await press(w, w.staff, first, 'deliver');
  assert.match(lastText(zero), /already at 0/);
  assert.equal(w.ctx.store.guild(w.guild.id).stock.items['netflix account'].quantity, 0);

  await stockCmd(w, 'remove', { item: 'netflix account' });
  const gone = await press(w, w.staff, second, 'deliver');
  assert.match(lastText(gone), /no longer exists, so no stock was taken off/);
  assert.equal(section(w).orders[2].status, 'delivered');

  const blocked = await pick(w, w.alice, 'netflix 1 month');
  assert.match(lastText(blocked), /isn't available right now/);
  const list = await shop(w, w.admin, 'list');
  assert.match(list.calls[0][1].content, /no longer exists[^\n]*\*\*Netflix 1 Month\*\*/);
  assert.match(json(list.calls[0][1].embeds[0]).fields[0].value, /Unavailable/);
});

test('the Close button still closes an order ticket with a transcript', async () => {
  const w = world();
  await ready(w);
  await pick(w, w.alice, 'netflix 1 month');
  const [ch] = orderChannels(w);
  ch.post(w.alice.user, 'sent the payment');
  const ask = await run(w, button({ guild: w.guild, member: w.alice, channel: ch, customId: 'ticket:close' }));
  assert.match(lastText(ask), /Close this ticket/);
  const confirm = await run(w, button({ guild: w.guild, member: w.staff, channel: ch, customId: 'ticket:confirm' }));
  assert.equal(confirm.calls[0][0], 'update');
  assert.match(w.logs.sent.at(-1).files[0].attachment.toString('utf8'), /alice: sent the payment/);
  await tick();
  assert.ok(ch.deleted);
  assert.equal(w.ctx.store.guild(w.guild.id).tickets.open[ch.id], undefined);
});

test('a double pick opens one order; buyers are capped at 3 open orders', async () => {
  const w = world();
  await ready(w, { quantity: 10 });
  const twice = [pickItem(w, w.alice, 'netflix 1 month'), pickItem(w, w.alice, 'netflix 1 month')];
  await Promise.all(twice.map(i => route(i, w.ctx)));
  assert.equal(orderChannels(w).length, 1);
  assert.ok(twice.some(i => /already being set up/.test(lastText(i))));

  await pick(w, w.alice, 'netflix 1 month');
  await pick(w, w.alice, 'netflix 1 month');
  const fourth = await pick(w, w.alice, 'netflix 1 month');
  assert.match(lastText(fourth), /already have 3 open orders/);
  assert.equal(orderChannels(w).length, 3);

  await orderChannels(w)[0].delete(); // deleted by hand: no longer counts
  const ok = await pick(w, w.alice, 'netflix 1 month');
  assert.match(lastText(ok), /order ticket is open/);
});

test('a failed channel create explains and releases the reservation', async () => {
  const w = world();
  await ready(w, { quantity: 1 });
  w.guild.channels.failCreate = true;
  const failed = await quiet(() => pick(w, w.alice, 'netflix 1 month'));
  assert.match(lastText(failed), /couldn't create your ticket channel/);
  assert.deepEqual(section(w).orders, {});
  w.guild.channels.failCreate = false;
  const ok = await pick(w, w.bob, 'netflix 1 month');
  assert.match(lastText(ok), /order ticket is open/);
});

test('after a restart, order buttons still work and a half-created order stops holding stock', async () => {
  const w = world();
  await ready(w, { quantity: 2 });
  await pick(w, w.alice, 'netflix 1 month');
  const [ch] = orderChannels(w);
  const s = section(w);
  // the bot crashed while creating Bob's ticket a while ago
  s.orders[s.nextOrderId] = {
    id: s.nextOrderId, productKey: 'netflix 1 month', product: 'Netflix 1 Month', price: '$5', stockKey: 'netflix account',
    buyerId: w.bob.id, status: 'creating', channelId: null, createdAt: Date.now() - 10 * 60 * 1000,
  };
  s.nextOrderId++;

  w.ctx.store.flush();
  w.ctx = { ...w.ctx, store: new Store(w.ctx.store.file) };
  const paid = await press(w, w.staff, ch, 'paid');
  assert.equal(paid.calls[0][0], 'update');
  assert.equal(section(w).orders[1].status, 'paid');

  const carol = w.guild.member('carol');
  const i = await pick(w, carol, 'netflix 1 month');
  assert.match(lastText(i), /order ticket is open/, 'only Alice holds a unit');
  const list = await shop(w, w.admin, 'orders');
  assert.doesNotMatch(json(list.calls[0][1].embeds[0]).description, /#2\*\*/, 'crashed order hidden');
});

test('an open order does not block a support ticket', async () => {
  const w = world();
  await ready(w);
  await pick(w, w.alice, 'netflix 1 month');
  const i = await run(w, button({ guild: w.guild, member: w.alice, channel: w.general, customId: 'ticket:open' }));
  assert.match(lastText(i), /Your ticket is open/);
  const support = [...w.guild.channels.cache.values()].find(c => c.name.startsWith('ticket-0'));
  assert.equal(support.name, 'ticket-0002-alice', 'shares the ticket counter');
  const again = await run(w, button({ guild: w.guild, member: w.alice, channel: w.general, customId: 'ticket:open' }));
  assert.match(lastText(again), /already have an open ticket/);
});

test('user text in products and payment cannot ping anyone', async () => {
  const w = world();
  await ticketSetup(w);
  await shop(w, w.admin, 'payment', { text: '@everyone pay <@&123> now' });
  await shop(w, w.admin, 'add', { name: '@everyone deal <@&123>', price: '@here' });
  await pick(w, w.alice, '@everyone deal <@&123>');
  const [ch] = orderChannels(w);
  const welcome = orderMessage(ch).payload;
  assert.equal(welcome.content, `<@${w.alice.id}> <@&${w.staffRole.id}>`);
  assert.deepEqual(welcome.allowedMentions, { users: [w.alice.id], roles: [w.staffRole.id] });
  await press(w, w.staff, ch, 'deliver');
  const prompt = ch.sent.at(-1);
  assert.deepEqual(prompt.allowedMentions, { users: [w.alice.id] });
});

test('a deleted staff role does not stop orders; Manage Server can still deliver', async () => {
  const w = world();
  await ready(w);
  w.guild.roles.cache.delete(w.staffRole.id);
  await pick(w, w.alice, 'netflix 1 month');
  const [ch] = orderChannels(w);
  const welcome = orderMessage(ch).payload;
  assert.equal(welcome.content, `<@${w.alice.id}>`);
  assert.deepEqual(welcome.allowedMentions, { users: [w.alice.id], roles: [] });
  const done = await press(w, w.admin, ch, 'deliver');
  assert.equal(done.calls[0][0], 'update');
});

test('shop orders can filter by buyer; empty lists say so', async () => {
  const w = world();
  const none = await shop(w, w.admin, 'orders');
  assert.match(lastText(none), /No orders yet/);
  await ready(w, { quantity: 5 });
  await pick(w, w.alice, 'netflix 1 month');
  await pick(w, w.bob, 'netflix 1 month');
  const bobs = await shop(w, w.admin, 'orders', { buyer: w.bob.user });
  const embed = json(bobs.calls[0][1].embeds[0]);
  assert.equal(embed.title, 'Orders from bob');
  assert.match(embed.description, /\*\*#2\*\*/);
  assert.doesNotMatch(embed.description, /\*\*#1\*\*/);
  assert.match(embed.description, /waiting for payment in <#/);
  const nobody = await shop(w, w.admin, 'orders', { buyer: w.staff.user });
  assert.match(lastText(nobody), /hasn't ordered anything yet/);
});

test('payment instructions can be replaced and removed', async () => {
  const w = world();
  const set = await shop(w, w.admin, 'payment', { text: '  CashApp $shop  ' });
  assert.match(lastText(set), />>> CashApp \$shop$/);
  assert.equal(section(w).payment, 'CashApp $shop');
  const cleared = await shop(w, w.admin, 'payment', { text: 'none' });
  assert.match(lastText(cleared), /removed/);
  assert.equal(section(w).payment, null);

  await ticketSetup(w);
  await shop(w, w.admin, 'add', { name: 'Logo', price: '$25' });
  await pick(w, w.alice, 'logo');
  const [ch] = orderChannels(w);
  const pay = json(orderMessage(ch).payload.embeds[0]).fields.find(f => f.name === 'How to pay').value;
  assert.match(pay, /staff member will tell you/);
});

const closeTicket = async (w, member, ch) => {
  await run(w, button({ guild: w.guild, member, channel: ch, customId: 'ticket:confirm' }));
  await tick();
};
// the next ticket channel created rejects every message, like Discord rejecting a malformed embed
function failNextOrderMessage(w) {
  const create = w.guild.channels.create;
  w.guild.channels.create = async opts => {
    w.guild.channels.create = create;
    const ch = await create(opts);
    ch.failSend = true;
    return ch;
  };
}

test('image links are stored encoded, so a space cannot break every order message', async () => {
  const w = world();
  await shop(w, w.admin, 'add', { name: 'Logo', price: '$5', image_url: 'https://cdn.example.com/my logo.png' });
  assert.equal(section(w).products.logo.imageUrl, 'https://cdn.example.com/my%20logo.png');
});

test('an order message that fails to post cancels the order, deletes the channel and frees the stock', async () => {
  const w = world();
  await ready(w, { quantity: 1 });
  failNextOrderMessage(w);
  const failed = await quiet(() => pick(w, w.alice, 'netflix 1 month'));
  assert.match(lastText(failed), /couldn't set up your order ticket, so I cancelled the order/);
  assert.deepEqual(section(w).orders, {});
  assert.equal(orderChannels(w).length, 0, 'empty channel deleted');
  assert.deepEqual(w.ctx.store.guild(w.guild.id).tickets.open, {});

  const ok = await pick(w, w.bob, 'netflix 1 month');
  assert.match(lastText(ok), /order ticket is open/, 'stock was released');
});

test('a paid order keeps its stock after its ticket is closed until /shop deliver or /shop cancel', async () => {
  const w = world();
  await ready(w, { quantity: 1 });
  await pick(w, w.alice, 'netflix 1 month');
  const [ch] = orderChannels(w);
  await press(w, w.staff, ch, 'paid');
  await closeTicket(w, w.alice, ch);
  assert.ok(ch.deleted);

  const bob = await pick(w, w.bob, 'netflix 1 month');
  assert.match(lastText(bob), /reserved by an open order/, 'not sold twice');
  const list = await shop(w, w.admin, 'orders');
  assert.match(json(list.calls[0][1].embeds[0]).description, /#1\*\*[^\n]*\n💰 paid, but the ticket was closed: finish it with `\/shop deliver order:1`/);

  const done = await shop(w, w.admin, 'deliver', { order: 1 });
  assert.match(lastText(done), /Marked order #1 \(\*\*Netflix 1 Month\*\* for <@\d+>\) as delivered\. \*\*Netflix Account\*\* now has 0 left/);
  assert.equal(section(w).orders[1].deliveredBy, w.admin.id);
  assert.equal(w.ctx.store.guild(w.guild.id).stock.items['netflix account'].quantity, 0);
  const again = await shop(w, w.admin, 'deliver', { order: 1 });
  assert.match(lastText(again), /already delivered order #1/);
  assert.equal(w.ctx.store.guild(w.guild.id).stock.items['netflix account'].quantity, 0, 'stock only taken once');
  const late = await shop(w, w.admin, 'cancel', { order: 1 });
  assert.match(lastText(late), /already delivered/);
  const missing = await shop(w, w.admin, 'deliver', { order: 99 });
  assert.match(lastText(missing), /no order #99/);
});

test('/shop cancel releases a paid order without taking stock; its buttons stop working', async () => {
  const w = world();
  await ready(w, { quantity: 1 });
  await pick(w, w.alice, 'netflix 1 month');
  const [ch] = orderChannels(w);
  await press(w, w.staff, ch, 'paid');

  const cancel = await shop(w, w.admin, 'cancel', { order: 1 });
  assert.match(lastText(cancel), /Cancelled order #1/);
  assert.equal(section(w).orders[1].cancelledBy, w.admin.id);
  for (const action of ['paid', 'deliver']) {
    const i = await press(w, w.staff, ch, action);
    assert.match(lastText(i), /cancelled order #1/);
  }
  assert.equal(w.ctx.store.guild(w.guild.id).stock.items['netflix account'].quantity, 1);
  const bob = await pick(w, w.bob, 'netflix 1 month');
  assert.match(lastText(bob), /order ticket is open/);
  const list = await shop(w, w.admin, 'orders');
  assert.match(json(list.calls[0][1].embeds[0]).description, /#1\*\*[^\n]*\n🚫 cancelled by/);
  const twice = await shop(w, w.admin, 'cancel', { order: 1 });
  assert.match(lastText(twice), /already cancelled/);
});

test('an unpaid order stops holding stock after 30 minutes; paying late warns about overselling', async () => {
  const w = world();
  await ready(w, { quantity: 1 });
  await pick(w, w.alice, 'netflix 1 month');
  const [aliceCh] = orderChannels(w);
  assert.match(json(orderMessage(aliceCh).payload.embeds[0]).description, /held for 30 minutes/);
  assert.match(lastText(await pick(w, w.bob, 'netflix 1 month')), /reserved by an open order/);

  section(w).orders[1].createdAt -= 31 * 60 * 1000;
  const bob = await pick(w, w.bob, 'netflix 1 month');
  assert.match(lastText(bob), /order ticket is open/);
  const list = await shop(w, w.admin, 'orders', { buyer: w.alice.user });
  assert.match(json(list.calls[0][1].embeds[0]).description, /waiting for payment in <#\d+>, no longer holding stock/);

  const bobCh = orderChannels(w).find(c => c !== aliceCh);
  await press(w, w.staff, bobCh, 'paid');
  const late = await press(w, w.staff, aliceCh, 'paid');
  assert.equal(late.calls[0][0], 'update');
  assert.match(lastText(late), /More orders are waiting for \*\*Netflix Account\*\* than \/stock has \(1\)/);
  assert.ok(isEphemeral(late.calls.at(-1)[1]));
});

test('a buyer can place at most 5 orders an hour, even after closing them', async () => {
  const w = world();
  await ready(w, { quantity: 10 });
  for (let n = 0; n < 5; n++) {
    const i = await pick(w, w.alice, 'netflix 1 month');
    assert.match(lastText(i), /order ticket is open/);
    await closeTicket(w, w.alice, orderChannels(w)[0]);
  }
  const pings = () => orderChannels(w).length;
  const sixth = await pick(w, w.alice, 'netflix 1 month');
  assert.match(lastText(sixth), /placed 5 orders in the last hour\. You can order again <t:\d+:R>/);
  assert.equal(pings(), 0, 'no channel, no staff ping');
  assert.match(lastText(await pick(w, w.bob, 'netflix 1 month')), /order ticket is open/, 'other buyers unaffected');

  section(w).orders[1].createdAt -= 61 * 60 * 1000;
  const later = await pick(w, w.alice, 'netflix 1 month');
  assert.match(lastText(later), /order ticket is open/);
});
