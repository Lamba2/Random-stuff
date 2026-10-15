const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits: P, OverwriteType } = require('discord.js');
const { makeGuild, command, button, lastText, isEphemeral, makeCtx, tick, PermissionsBitField } = require('./fakes');
const { buildRouter } = require('../src/router');
const { commands } = require('../src/commands');

const route = buildRouter(commands);

function world() {
  const ctx = makeCtx();
  const guild = makeGuild();
  const staffRole = guild.makeRole('Staff', 5);
  const panelChannel = guild.textChannel('support');
  const logChannel = guild.textChannel('ticket-logs');
  const category = guild.textChannel('Tickets', { type: ChannelType.GuildCategory });
  const admin = guild.member('admin', { perms: P.ManageGuild });
  const alice = guild.member('alice');
  const bob = guild.member('bob');
  const staff = guild.member('helper', { roles: [staffRole] });
  return { ctx, guild, staffRole, panelChannel, logChannel, category, admin, alice, bob, staff };
}

async function setUp(w, extra = {}) {
  const i = command({
    guild: w.guild, member: w.admin, channel: w.panelChannel, commandName: 'ticket', subcommand: 'setup',
    options: { channel: w.panelChannel, staff_role: w.staffRole, category: w.category, log_channel: w.logChannel, ...extra },
  });
  await route(i, w.ctx);
  return i;
}

async function openTicket(w, member) {
  const i = button({ guild: w.guild, member, channel: w.panelChannel, customId: 'ticket:open' });
  await route(i, w.ctx);
  return i;
}

const ticketChannels = w => [...w.guild.channels.cache.values()].filter(c => c.name.startsWith('ticket-0'));

test('setup is refused without Manage Server', async () => {
  const w = world();
  const i = command({ guild: w.guild, member: w.alice, channel: w.panelChannel, commandName: 'ticket', subcommand: 'setup',
    options: { channel: w.panelChannel, staff_role: w.staffRole } });
  await route(i, w.ctx);
  assert.match(lastText(i), /Manage Server/);
  assert.equal(w.ctx.store.guild(w.guild.id).tickets.config, null);
  assert.equal(w.panelChannel.sent.length, 0);
});

test('setup refuses @everyone as the staff role', async () => {
  const w = world();
  const i = await setUp(w, { staff_role: w.guild.roles.everyone });
  assert.match(lastText(i), /not @everyone/);
  assert.equal(w.ctx.store.guild(w.guild.id).tickets.config, null);
});

test('setup explains missing bot permissions', async () => {
  const w = world();
  w.guild.me.permissions = new PermissionsBitField([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ManageChannels]);
  const i = await setUp(w);
  assert.match(lastText(i), /Manage Roles/);
});

test('setup posts the panel and saves config', async () => {
  const w = world();
  const i = await setUp(w);
  assert.ok(isEphemeral(i.calls[0][1]));
  assert.match(lastText(i), /Ticket panel posted/);
  const panel = w.panelChannel.sent[0];
  assert.equal(panel.components[0].toJSON().components[0].custom_id, 'ticket:open');
  assert.deepEqual(w.ctx.store.guild(w.guild.id).tickets.config, {
    staffRoleId: w.staffRole.id, categoryId: w.category.id, logChannelId: w.logChannel.id,
  });
});

test('opening a ticket before setup explains why', async () => {
  const w = world();
  const i = await openTicket(w, w.alice);
  assert.match(lastText(i), /not set up/);
});

test('open creates a private channel with the right permissions', async () => {
  const w = world();
  await setUp(w);
  const i = await openTicket(w, w.alice);
  const [created] = ticketChannels(w);
  assert.ok(created, 'ticket channel created');
  assert.equal(created.name, 'ticket-0001-alice');
  assert.equal(created.parentId, w.category.id);
  assert.match(lastText(i), new RegExp(created.id));
  assert.ok(isEphemeral(i.calls[0][1]), 'deferred ephemerally');

  const ow = Object.fromEntries(created.overwrites.map(o => [o.id, o]));
  assert.deepEqual(ow[w.guild.id].deny, [P.ViewChannel]);
  assert.equal(ow[w.guild.id].type, OverwriteType.Role);
  assert.ok(ow[w.alice.id].allow.includes(P.ViewChannel));
  assert.equal(ow[w.alice.id].type, OverwriteType.Member);
  assert.ok(ow[w.guild.me.id].allow.includes(P.ManageChannels));
  assert.ok(ow[w.staffRole.id].allow.includes(P.SendMessages));

  const welcome = created.sent[0];
  assert.match(welcome.content, new RegExp(w.alice.id));
  assert.deepEqual(welcome.allowedMentions, { users: [w.alice.id], roles: [w.staffRole.id] });
  assert.equal(welcome.components[0].toJSON().components[0].custom_id, 'ticket:close');
  assert.equal(w.ctx.store.guild(w.guild.id).tickets.open[created.id].ownerId, w.alice.id);
});

test('a second open points at the existing ticket', async () => {
  const w = world();
  await setUp(w);
  await openTicket(w, w.alice);
  const i = await openTicket(w, w.alice);
  assert.match(lastText(i), /already have an open ticket/);
  assert.equal(ticketChannels(w).length, 1);
});

test('a double click only creates one ticket', async () => {
  const w = world();
  await setUp(w);
  const [a, b] = await Promise.all([openTicket(w, w.alice), openTicket(w, w.alice)]);
  assert.equal(ticketChannels(w).length, 1);
  assert.ok([lastText(a), lastText(b)].some(t => /already being created/.test(t)));
});

test('a ticket deleted by hand is forgotten and numbering continues', async () => {
  const w = world();
  await setUp(w);
  await openTicket(w, w.alice);
  await ticketChannels(w)[0].delete();
  await openTicket(w, w.alice);
  const [second] = ticketChannels(w);
  assert.equal(second.name, 'ticket-0002-alice');
  assert.equal(Object.keys(w.ctx.store.guild(w.guild.id).tickets.open).length, 1);
});

test('channel creation failure gives a useful message', async () => {
  const w = world();
  await setUp(w);
  w.guild.channels.failCreate = true;
  const orig = console.error;
  console.error = () => {};
  try {
    const i = await openTicket(w, w.alice);
    assert.match(lastText(i), /couldn't create your ticket channel/);
  } finally {
    console.error = orig;
  }
});

test('strangers cannot close a ticket, the owner can, with a transcript', async () => {
  const w = world();
  await setUp(w);
  await openTicket(w, w.alice);
  const [ch] = ticketChannels(w);
  ch.post(w.alice.user, 'my order never arrived');
  ch.post(w.staff.user, 'looking into it');

  const stranger = button({ guild: w.guild, member: w.bob, channel: ch, customId: 'ticket:close' });
  await route(stranger, w.ctx);
  assert.match(lastText(stranger), /Only the person who opened/);

  const ask = button({ guild: w.guild, member: w.alice, channel: ch, customId: 'ticket:close' });
  await route(ask, w.ctx);
  assert.ok(isEphemeral(ask.calls[0][1]));
  assert.equal(ask.calls[0][1].components[0].toJSON().components[0].custom_id, 'ticket:confirm');

  const confirm = button({ guild: w.guild, member: w.alice, channel: ch, customId: 'ticket:confirm' });
  await route(confirm, w.ctx);
  assert.equal(confirm.calls[0][0], 'update');

  const log = w.logChannel.sent.at(-1);
  assert.ok(log, 'transcript posted to log channel');
  const transcript = log.files[0].attachment.toString('utf8');
  assert.match(transcript, /alice: my order never arrived/);
  assert.match(transcript, /helper: looking into it/);
  assert.equal(log.files[0].name, 'ticket-0001.txt');
  assert.equal(confirm.dms[0].userId, w.alice.id);

  await tick();
  assert.ok(ch.deleted, 'channel deleted after the delay');
  assert.equal(w.ctx.store.guild(w.guild.id).tickets.open[ch.id], undefined, 'record dropped once the channel is gone');
});

test('setup refuses when the bot lacks a permission the ticket overwrites need', async () => {
  const w = world();
  w.guild.me.permissions = new PermissionsBitField(PermissionsBitField.All).remove(P.Administrator, P.AttachFiles);
  const i = await setUp(w);
  assert.match(lastText(i), /Attach Files/);
  assert.equal(w.ctx.store.guild(w.guild.id).tickets.config, null);
});

test('setup warns when the staff role cannot be pinged', async () => {
  const w = world();
  w.guild.me.permissions = new PermissionsBitField(PermissionsBitField.All).remove(P.Administrator, P.MentionEveryone);
  const quiet = await setUp(w);
  assert.match(lastText(quiet), /won't notify/);
  w.staffRole.mentionable = true;
  const loud = await setUp(w);
  assert.doesNotMatch(lastText(loud), /won't notify/);
});

test('with no log channel and closed DMs, the closer gets the transcript', async () => {
  const w = world();
  await setUp(w, { log_channel: undefined });
  await openTicket(w, w.alice);
  const [ch] = ticketChannels(w);
  const confirm = button({ guild: w.guild, member: w.staff, channel: ch, customId: 'ticket:confirm' });
  confirm.dmFails = true;
  await route(confirm, w.ctx);
  const handed = confirm.calls.find(([k]) => k === 'followUp');
  assert.ok(handed, 'transcript handed to the closer');
  assert.ok(isEphemeral(handed[1]));
  assert.equal(handed[1].files[0].name, 'ticket-0001.txt');
  await tick();
  assert.ok(ch.deleted);
});

test('if the transcript cannot be saved anywhere, the ticket is kept', async () => {
  const w = world();
  await setUp(w);
  await openTicket(w, w.alice);
  const [ch] = ticketChannels(w);
  w.logChannel.failSend = true;
  const orig = console.error;
  console.error = () => {};
  try {
    const confirm = button({ guild: w.guild, member: w.staff, channel: ch, customId: 'ticket:confirm' });
    confirm.dmFails = true;
    confirm.followUpFails = true;
    await route(confirm, w.ctx);
    await tick();
    assert.equal(ch.deleted, false, 'channel kept');
    assert.ok(w.ctx.store.guild(w.guild.id).tickets.open[ch.id], 'still an open ticket');
    assert.match(ch.sent.at(-1).content, /Close cancelled/);

    w.logChannel.failSend = false; // admin fixes the log channel, closes again
    const retry = button({ guild: w.guild, member: w.staff, channel: ch, customId: 'ticket:confirm' });
    await route(retry, w.ctx);
    await tick();
    assert.ok(ch.deleted);
  } finally {
    console.error = orig;
  }
});

test('a failed channel delete leaves a ticket that can be closed again', async () => {
  const w = world();
  await setUp(w);
  await openTicket(w, w.alice);
  const [ch] = ticketChannels(w);
  ch.failDelete = true;
  const orig = console.error;
  console.error = () => {};
  try {
    await route(button({ guild: w.guild, member: w.alice, channel: ch, customId: 'ticket:confirm' }), w.ctx);
    await tick();
    assert.equal(ch.deleted, false);
    assert.ok(w.ctx.store.guild(w.guild.id).tickets.open[ch.id], 'record kept so Close still works');
    ch.failDelete = false;
    const again = button({ guild: w.guild, member: w.alice, channel: ch, customId: 'ticket:close' });
    await route(again, w.ctx);
    assert.match(lastText(again), /Close this ticket/);
    await route(button({ guild: w.guild, member: w.alice, channel: ch, customId: 'ticket:confirm' }), w.ctx);
    await tick();
    assert.ok(ch.deleted);
  } finally {
    console.error = orig;
  }
});

test('channel create failing on missing permissions names them', async () => {
  const w = world();
  await setUp(w);
  w.guild.me.permissions = new PermissionsBitField(PermissionsBitField.All).remove(P.Administrator, P.EmbedLinks);
  w.guild.channels.create = async () => { const e = new Error('Missing Permissions'); e.code = 50013; throw e; };
  const orig = console.error;
  console.error = () => {};
  try {
    const i = await openTicket(w, w.alice);
    assert.match(lastText(i), /missing \*\*Embed Links\*\*/);
  } finally {
    console.error = orig;
  }
});

test('staff can close any ticket via /ticket close; closed DMs do not break closing', async () => {
  const w = world();
  await setUp(w);
  await openTicket(w, w.alice);
  const [ch] = ticketChannels(w);
  const ask = command({ guild: w.guild, member: w.staff, channel: ch, commandName: 'ticket', subcommand: 'close' });
  await route(ask, w.ctx);
  assert.match(lastText(ask), /Close this ticket/);
  const confirm = button({ guild: w.guild, member: w.staff, channel: ch, customId: 'ticket:confirm' });
  confirm.dmFails = true;
  await route(confirm, w.ctx);
  await tick();
  assert.ok(ch.deleted);
  assert.ok(w.logChannel.sent.length >= 1);
});

test('confirming twice does not double-close', async () => {
  const w = world();
  await setUp(w);
  await openTicket(w, w.alice);
  const [ch] = ticketChannels(w);
  w.ctx.ticketDeleteDelayMs = 50;
  const c1 = button({ guild: w.guild, member: w.alice, channel: ch, customId: 'ticket:confirm' });
  const c2 = button({ guild: w.guild, member: w.alice, channel: ch, customId: 'ticket:confirm' });
  await Promise.all([route(c1, w.ctx), route(c2, w.ctx)]);
  const texts = [lastText(c1), lastText(c2)];
  assert.ok(texts.some(t => /already (closing|closed)/.test(t)), texts.join(' | '));
  assert.equal(w.logChannel.sent.length, 1);
  await tick(80);
});

test('/ticket add and remove: staff only, owner cannot be removed', async () => {
  const w = world();
  await setUp(w);
  await openTicket(w, w.alice);
  const [ch] = ticketChannels(w);

  const notStaff = command({ guild: w.guild, member: w.alice, channel: ch, commandName: 'ticket', subcommand: 'add', options: { user: w.bob.user } });
  await route(notStaff, w.ctx);
  assert.match(lastText(notStaff), /Only staff/);

  const add = command({ guild: w.guild, member: w.staff, channel: ch, commandName: 'ticket', subcommand: 'add', options: { user: w.bob.user } });
  await route(add, w.ctx);
  assert.equal(ch.permissionOverwrites.edits[0].who, w.bob.user);
  assert.equal(ch.permissionOverwrites.edits[0].extra.type, OverwriteType.Member);
  assert.match(lastText(add), /added/);

  const removeOwner = command({ guild: w.guild, member: w.staff, channel: ch, commandName: 'ticket', subcommand: 'remove', options: { user: w.alice.user } });
  await route(removeOwner, w.ctx);
  assert.match(lastText(removeOwner), /can't remove the person who opened/);

  const remove = command({ guild: w.guild, member: w.staff, channel: ch, commandName: 'ticket', subcommand: 'remove', options: { user: w.bob.user } });
  await route(remove, w.ctx);
  assert.equal(ch.permissionOverwrites.deletes[0].who, w.bob.user);
});

test('ticket commands outside a ticket channel say so', async () => {
  const w = world();
  await setUp(w);
  const i = command({ guild: w.guild, member: w.admin, channel: w.panelChannel, commandName: 'ticket', subcommand: 'close' });
  await route(i, w.ctx);
  assert.match(lastText(i), /not an open ticket/);
});
