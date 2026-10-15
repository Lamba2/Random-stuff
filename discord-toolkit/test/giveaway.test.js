const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { lastText, isEphemeral, PermissionsBitField } = require('./fakes');
const { world, restart, quiet, settle, embedOf, lastEdit, unix, MAX_TIMER } = require('./giveaway-helpers');
const { parseDuration, drawWinners } = require('../src/commands/giveaway');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const announcements = channel => channel.sent.filter(p => typeof p.content === 'string' && p.content.length);
const mentioned = text => [...text.matchAll(/<@(\d+)>/g)].map(m => m[1]);

// ---------- durations ----------

test('parseDuration reads units, combinations and spacing', () => {
  assert.equal(parseDuration('30s'), 30 * SEC);
  assert.equal(parseDuration('10m'), 10 * MIN);
  assert.equal(parseDuration('2h'), 2 * HOUR);
  assert.equal(parseDuration('3d'), 3 * DAY);
  assert.equal(parseDuration('1w'), 7 * DAY);
  assert.equal(parseDuration('1h30m'), 90 * MIN);
  assert.equal(parseDuration(' 1H 30M '), 90 * MIN);
  assert.equal(parseDuration('2 days, 4 hours'), 2 * DAY + 4 * HOUR);
  assert.equal(parseDuration('1w2d3h4m5s'), 9 * DAY + 3 * HOUR + 4 * MIN + 5 * SEC);
  assert.equal(parseDuration('1.5h'), 90 * MIN);
  for (const bad of ['', '   ', '30', 'soon', '10x', '1h30', '-5m', '1e3s', 'h', '1 30m', '1h-30m', null, undefined]) {
    assert.equal(parseDuration(bad), null, `${JSON.stringify(bad)} is not a duration`);
  }
});

test('start rejects unreadable, too short and too long durations', async () => {
  const w = world();
  for (const [duration, why] of [['tomorrow', /couldn't read `tomorrow`/], ['9s', /at least 10 seconds/], ['31d', /at most 30 days/], ['4w3d', /at most 30 days/], ['`x`', /couldn't read `'x'`/]]) {
    const i = await w.cmd(w.admin, 'start', { prize: 'Nitro', duration });
    assert.match(lastText(i), why);
    assert.ok(isEphemeral(i.calls[0][1]));
  }
  assert.equal(w.general.history.length, 0, 'nothing posted');
  const ok = await w.start({ duration: '10s' });
  assert.match(lastText(ok.i), /started/);
  const max = await w.start({ duration: '30d' });
  assert.match(lastText(max.i), /started/);
});

// ---------- start ----------

test('start is refused without Manage Server', async () => {
  const w = world();
  const alice = w.member('alice');
  const i = await w.cmd(alice, 'start', { prize: 'Nitro', duration: '1h' });
  assert.match(lastText(i), /Manage Server/);
  assert.equal(w.general.history.length, 0);
  assert.equal(w.time.pending, 0);
});

test('start posts the giveaway with a Join button and remembers it', async () => {
  const w = world();
  const vip = w.guild.makeRole('VIP', 3);
  const shop = w.guild.textChannel('giveaways');
  const startedAt = w.time.now();
  const { i, message, gw } = await w.start({ prize: '  Steam \n key ', duration: '2h', winners: 3, channel: shop, required_role: vip });

  assert.equal(i.calls[0][0], 'deferReply');
  assert.ok(isEphemeral(i.calls[0][1]));
  assert.match(lastText(i), new RegExp(`started in <#${shop.id}>.*\\n.*${message.id}`));

  const embed = message.embeds[0];
  assert.equal(embed.title, '🎉 Steam key');
  assert.match(embed.description, new RegExp(`<t:${unix(startedAt + 2 * HOUR)}:R>`));
  assert.match(embed.description, /\*\*Winners:\*\* 3/);
  assert.match(embed.description, new RegExp(`Hosted by:\\*\\* <@${w.admin.id}>`));
  assert.match(embed.description, new RegExp(`Required role:\\*\\* <@&${vip.id}>`));
  assert.match(embed.description, /\*\*Entries:\*\* 0/);
  assert.equal(message.payload.content, undefined, 'no content, so nothing can ping');
  const btn = message.payload.components[0].toJSON().components[0];
  assert.equal(btn.custom_id, 'giveaway:join');
  assert.equal(btn.label, 'Join');

  assert.equal(gw.prize, 'Steam key');
  assert.equal(gw.channelId, shop.id);
  assert.equal(gw.winnerCount, 3);
  assert.equal(gw.hostId, w.admin.id);
  assert.equal(gw.requiredRoleId, vip.id);
  assert.equal(gw.endsAt, startedAt + 2 * HOUR);
  assert.equal(gw.status, 'running');
  assert.deepEqual(gw.entrants, []);
  assert.deepEqual(w.time.delays, [2 * HOUR]);
});

test('start uses the current channel, treats @everyone as no requirement, and checks the bot can post', async () => {
  const w = world();
  const { message, gw } = await w.start({ required_role: w.guild.roles.everyone });
  assert.equal(message.channel, w.general);
  assert.equal(gw.winnerCount, 1);
  assert.equal(gw.requiredRoleId, null);
  assert.doesNotMatch(message.embeds[0].description, /Required role/);

  const locked = w.guild.textChannel('locked');
  locked.botPerms = new PermissionsBitField(PermissionsBitField.All).remove(P.Administrator, P.ReadMessageHistory).bitfield;
  const i = await w.cmd(w.admin, 'start', { prize: 'Nitro', duration: '1h', channel: locked });
  assert.match(lastText(i), /Read Message History/);
  assert.equal(locked.history.length, 0);

  const announcementsOnly = w.guild.textChannel('announcements');
  const readOnly = new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]);
  announcementsOnly.permissionsFor = who => (who === w.guild.me ? new PermissionsBitField(PermissionsBitField.All) : readOnly);
  const k = await w.cmd(w.admin, 'start', { prize: 'Nitro', duration: '1h', channel: announcementsOnly });
  assert.match(lastText(k), /where you can send messages yourself/);
  assert.equal(announcementsOnly.history.length, 0);

  const category = w.guild.textChannel('Events', { type: 4 });
  const j = await w.cmd(w.admin, 'start', { prize: 'Nitro', duration: '1h' }, category);
  assert.match(lastText(j), /Pick a text channel/);
});

// ---------- joining ----------

test('Join toggles entry with a private confirmation', async () => {
  const w = world();
  const { message } = await w.start({ prize: 'Nitro' });
  const alice = w.member('alice');

  const first = await w.press(alice, message);
  assert.ok(isEphemeral(first.calls[0][1]));
  assert.match(lastText(first), /You're in the giveaway for \*\*Nitro\*\*/);
  assert.deepEqual(w.gw(message.id).entrants, [alice.id]);

  await w.time.advance(2 * SEC);
  const second = await w.press(alice, message);
  assert.match(lastText(second), /You left/);
  assert.deepEqual(w.gw(message.id).entrants, []);
});

test('a double click does not join and then leave again', async () => {
  const w = world();
  const { message } = await w.start();
  const alice = w.member('alice');
  const [a, b] = await Promise.all([w.press(alice, message), w.press(alice, message)]);
  assert.deepEqual(w.gw(message.id).entrants, [alice.id]);
  assert.ok([lastText(a), lastText(b)].some(t => /You're entered.*press \*\*Join\*\* again in a moment/.test(t)));
  await w.time.advance(2 * SEC);
  assert.match(lastText(await w.press(alice, message)), /You left/);
});

test('the required role is checked on entry, but anyone can leave', async () => {
  const w = world();
  const vip = w.guild.makeRole('VIP', 3);
  const { message } = await w.start({ required_role: vip });
  const alice = w.member('alice');
  const bob = w.member('bob', { roles: [vip] });

  const refused = await w.press(alice, message);
  assert.match(lastText(refused), new RegExp(`need the <@&${vip.id}> role`));
  assert.deepEqual(w.gw(message.id).entrants, []);

  await w.press(bob, message);
  assert.deepEqual(w.gw(message.id).entrants, [bob.id]);
  bob.roles.cache.delete(vip.id);
  await w.time.advance(2 * SEC);
  assert.match(lastText(await w.press(bob, message)), /You left/);
});

test('a deleted required role blocks new entries but keeps existing entrants', async () => {
  const w = world();
  const vip = w.guild.makeRole('VIP', 3);
  const { message } = await w.start({ required_role: vip });
  const alice = w.member('alice', { roles: [vip] });
  await w.press(alice, message);
  w.guild.roles.cache.delete(vip.id);

  const bob = w.member('bob', { roles: [vip] });
  assert.match(lastText(await w.press(bob, message)), /was deleted/);
  await w.time.advance(HOUR);
  assert.deepEqual(w.gw(message.id).winners, [alice.id]);
});

test('entry count edits are throttled and always end on the final count', async () => {
  const w = world();
  const { message } = await w.start();
  for (let n = 0; n < 10; n++) await w.press(w.member(`fan${n}`), message);

  assert.equal(message.edits.length, 1, 'only the first join edits right away');
  assert.match(embedOf(message.edits[0]).description, /Entries:\*\* 1$/);
  await w.time.advance(4 * SEC);
  assert.equal(message.edits.length, 1);
  await w.time.advance(1 * SEC);
  assert.equal(message.edits.length, 2);
  assert.match(embedOf(lastEdit(message)).description, /Entries:\*\* 10$/);
  assert.equal(lastEdit(message).components.length, 1, 'still has the Join button');

  await w.time.advance(MIN);
  assert.equal(message.edits.length, 2, 'nothing left to show');
  const late = w.member('late');
  await w.press(late, message);
  assert.equal(message.edits.length, 3);
  assert.match(embedOf(lastEdit(message)).description, /Entries:\*\* 11$/);
});

// ---------- ending ----------

test('the timer draws distinct winners, pings only them and closes the giveaway', async () => {
  const w = world();
  const { message } = await w.start({ prize: 'Nitro', winners: 2 });
  const fans = Array.from({ length: 5 }, (_, n) => w.member(`fan${n}`));
  for (const f of fans) await w.press(f, message);
  const bystander = w.member('bystander');

  await w.time.advance(HOUR);
  const gw = w.gw(message.id);
  assert.equal(gw.status, 'ended');
  assert.equal(gw.winners.length, 2);
  assert.equal(new Set(gw.winners).size, 2);
  for (const id of gw.winners) assert.ok(fans.some(f => f.id === id));
  assert.ok(w.guild.members.fetchCalls.every(o => o.force === true), 'membership is checked with Discord, not the stale cache');

  const [ann] = announcements(w.general);
  assert.deepEqual(mentioned(ann.content).sort(), [...gw.winners].sort());
  assert.deepEqual(ann.allowedMentions, { users: gw.winners });
  assert.match(ann.content, /won \*\*Nitro\*\*/);
  assert.match(ann.content, new RegExp(`/channels/${w.guild.id}/${w.general.id}/${message.id}`));

  const ended = lastEdit(message);
  assert.deepEqual(ended.components, []);
  const embed = embedOf(ended);
  assert.match(embed.description, /This giveaway has ended/);
  for (const id of gw.winners) assert.match(embed.description, new RegExp(`<@${id}>`));
  assert.equal(embed.footer.text, 'Ended');

  assert.match(lastText(await w.press(bystander, message)), /no longer running/);
  assert.equal(w.time.pending, 0, 'no timers left behind');
});

test('members who left or lost the required role are skipped at the draw', async () => {
  const w = world();
  const vip = w.guild.makeRole('VIP', 3);
  const { message } = await w.start({ required_role: vip, winners: 3 });
  const [gone, demoted, stays] = ['gone', 'demoted', 'stays'].map(n => w.member(n, { roles: [vip] }));
  for (const m of [gone, demoted, stays]) await w.press(m, message);
  w.leave(gone); // still in the bot's cache, as it would be with only the Guilds intent
  demoted.roles.cache.delete(vip.id);

  await w.time.advance(HOUR);
  assert.deepEqual(w.gw(message.id).winners, [stays.id]);
  assert.deepEqual(announcements(w.general)[0].allowedMentions, { users: [stays.id] });
});

test('if Discord cannot be asked, the cache decides, and unknown members get the benefit of the doubt', async () => {
  const w = world();
  const vip = w.guild.makeRole('VIP', 3);
  const cachedOk = w.member('cachedOk', { roles: [vip] });
  const cachedNoRole = w.member('cachedNoRole');
  const uncached = w.member('uncached');
  w.guild.members.cache.delete(uncached.id);
  w.guild.members.failFetch = true;
  const gw = { entrants: [cachedOk.id, cachedNoRole.id, uncached.id], requiredRoleId: vip.id };
  const winners = await drawWinners(w.guild, gw, 3);
  assert.deepEqual(winners.sort(), [cachedOk.id, uncached.id].sort());
});

test('drawWinners is uniform and never repeats a winner', async () => {
  const w = world();
  const ids = ['a', 'b', 'c', 'd'].map(n => w.member(n).id);
  const gw = { entrants: ids, requiredRoleId: null };
  const counts = Object.fromEntries(ids.map(id => [id, 0]));
  for (let n = 0; n < 4000; n++) counts[(await drawWinners(w.guild, gw, 1))[0]]++;
  for (const id of ids) assert.ok(Math.abs(counts[id] - 1000) < 150, `picked ${counts[id]} of 4000 times`);

  const all = await drawWinners(w.guild, gw, 4);
  assert.deepEqual([...all].sort(), [...ids].sort());
  const excluded = await drawWinners(w.guild, gw, 4, new Set(ids.slice(0, 3)));
  assert.deepEqual(excluded, [ids[3]]);
});

test('no valid entries ends the giveaway without a winner or a ping', async () => {
  const w = world();
  const { message } = await w.start({ prize: 'Nitro' });
  const alice = w.member('alice');
  await w.press(alice, message);
  w.leave(alice);
  await w.time.advance(HOUR);

  const gw = w.gw(message.id);
  assert.equal(gw.status, 'ended');
  assert.deepEqual(gw.winners, []);
  const [ann] = announcements(w.general);
  assert.match(ann.content, /no valid entries/);
  assert.deepEqual(ann.allowedMentions, { parse: [] });
  assert.match(embedOf(lastEdit(message)).description, /Winners:\*\* no valid entries/);
});

test('with fewer entrants than winners, everyone eligible wins', async () => {
  const w = world();
  const { message } = await w.start({ winners: 5 });
  const a = w.member('a');
  const b = w.member('b');
  await w.press(a, message);
  await w.press(b, message);
  const i = await w.cmd(w.admin, 'end', { message_id: message.id });
  assert.match(lastText(i), /Ended the giveaway/);
  assert.deepEqual([...w.gw(message.id).winners].sort(), [a.id, b.id].sort());
});

// Holds every member lookup until open() is called, so a draw can be caught halfway.
function holdDraws(w) {
  let open;
  w.guild.members.gate = new Promise(r => { open = r; });
  return () => { w.guild.members.gate = null; open(); };
}

test('/giveaway end arriving while the timer is drawing winners does not draw twice', async () => {
  const w = world();
  const { message } = await w.start();
  const alice = w.member('alice');
  await w.press(alice, message);

  const release = holdDraws(w);
  const firing = w.time.advance(HOUR);
  await settle();
  const manual = await w.cmd(w.admin, 'end', { message_id: message.id });
  assert.match(lastText(manual), /already being ended/);
  assert.match(lastText(await w.press(w.member('latecomer'), message)), /no longer running/, 'no joining mid-draw');
  release();
  await firing;

  assert.equal(announcements(w.general).length, 1);
  assert.equal(message.edits.filter(e => e.components.length === 0).length, 1);
  assert.deepEqual(w.gw(message.id).winners, [alice.id]);
  assert.match(lastText(await w.cmd(w.admin, 'end', { message_id: message.id })), /already ended/);
});

test('two /giveaway end commands at once draw and announce exactly once, and the timer stays quiet', async () => {
  const w = world();
  const { message } = await w.start();
  const alice = w.member('alice');
  await w.press(alice, message);

  const release = holdDraws(w);
  const both = Promise.all([
    w.cmd(w.admin, 'end', { message_id: message.id }),
    w.cmd(w.admin, 'end', { message_id: message.id }),
  ]);
  await settle();
  release();
  const replies = (await both).map(lastText);
  assert.equal(replies.filter(t => /Ended the giveaway/.test(t)).length, 1, replies.join(' | '));
  assert.equal(replies.filter(t => /already being ended/.test(t)).length, 1, replies.join(' | '));

  await w.time.advance(DAY);
  assert.equal(announcements(w.general).length, 1);
  assert.equal(message.edits.filter(e => e.components.length === 0).length, 1);
  assert.deepEqual(w.gw(message.id).winners, [alice.id]);
});

test('a deleted giveaway message or channel cancels the giveaway instead of drawing', async () => {
  const w = world();
  const { message } = await w.start();
  const alice = w.member('alice');
  await w.press(alice, message);
  await w.general.messages.delete(message.id);
  await w.time.advance(HOUR);
  assert.equal(w.gw(message.id).status, 'cancelled');
  assert.equal(announcements(w.general).length, 0);

  const side = w.guild.textChannel('side');
  const other = await w.start({ channel: side });
  await w.press(alice, other.message);
  await side.delete();
  const i = await w.cmd(w.admin, 'end', { message_id: other.message.id });
  assert.match(lastText(i), /was deleted, so I cancelled/);
  assert.equal(w.gw(other.message.id).status, 'cancelled');
  assert.equal(w.time.pending, 0);
});

test('a failed announcement is reported to the admin, and the embed still shows the winner', async () => {
  const w = world();
  const { message } = await w.start();
  const alice = w.member('alice');
  await w.press(alice, message);
  w.general.failSend = true;
  let i;
  const logged = await quiet(async () => { i = await w.cmd(w.admin, 'end', { message_id: message.id }); });
  assert.match(lastText(i), /couldn't post the announcement/);
  assert.ok(logged.some(l => /Announcing giveaway winners failed/.test(l)));
  assert.match(embedOf(lastEdit(message)).description, new RegExp(`<@${alice.id}>`));
  assert.equal(w.gw(message.id).status, 'ended');
});

test('a crash halfway through a draw retries a minute later instead of leaving the giveaway stuck', async () => {
  const w = world();
  const { message } = await w.start();
  const alice = w.member('alice');
  await w.press(alice, message);
  w.ctx.random = () => { throw new Error('rng exploded'); };
  const logged = await quiet(() => w.time.advance(HOUR));
  assert.ok(logged.some(l => /Ending a giveaway failed.*rng exploded/.test(l)));
  assert.equal(w.gw(message.id).status, 'running');
  assert.match(lastText(await w.press(w.member('bob'), message)), /no longer running/, 'past its end time, so closed to entries');

  delete w.ctx.random;
  await w.time.advance(MIN);
  assert.equal(w.gw(message.id).status, 'ended');
  assert.deepEqual(w.gw(message.id).winners, [alice.id]);
  assert.equal(announcements(w.general).length, 1);
});

test('a giveaway in a server the bot has left waits instead of crashing', async () => {
  const w = world();
  const { message } = await w.start();
  w.client.guilds.cache.delete(w.guild.id);
  await w.time.advance(HOUR);
  assert.equal(w.gw(message.id).status, 'running');
  assert.equal(announcements(w.general).length, 0);
});

// ---------- restarts and long timers ----------

test('giveaways resume after a restart, and overdue ones end right away', async () => {
  const w = world();
  const a = await w.start({ prize: 'Alpha', duration: '1h' });
  const b = await w.start({ prize: 'Beta', duration: '3h' });
  const alice = w.member('alice');
  await w.press(alice, a.message);
  await w.press(alice, b.message);
  await w.time.advance(30 * MIN); // the bot goes down here...

  await restart(w, w.time.now() + 2 * HOUR); // ...and comes back after Alpha should have ended
  await w.time.advance(0);
  assert.equal(w.gw(a.message.id).status, 'ended');
  assert.deepEqual(w.gw(a.message.id).winners, [alice.id], 'entries survived the restart');
  assert.match(announcements(w.general)[0].content, /Alpha/);
  assert.equal(w.gw(b.message.id).status, 'running');

  const bob = w.member('bob');
  assert.match(lastText(await w.press(bob, b.message)), /You're in/);
  await w.time.advance(30 * MIN);
  assert.equal(w.gw(b.message.id).status, 'ended');
  assert.equal(announcements(w.general).length, 2);
});

test('a restart shows an entry count that was still waiting to be edited', async () => {
  const w = world();
  const { message } = await w.start();
  for (const n of ['a', 'b', 'c']) await w.press(w.member(n), message);
  assert.match(embedOf(lastEdit(message)).description, /Entries:\*\* 1$/);

  await restart(w, w.time.now() + SEC);
  assert.match(embedOf(lastEdit(message)).description, /Entries:\*\* 3$/);
  const edits = message.edits.length;
  await restart(w, w.time.now() + SEC);
  assert.equal(message.edits.length, edits, 'no edit when the count is already right');
});

test('ended giveaways can be rerolled after a restart, and are forgotten after 30 days', async () => {
  const w = world();
  const { message } = await w.start();
  const [a, b] = [w.member('a'), w.member('b')];
  await w.press(a, message);
  await w.press(b, message);
  await w.time.advance(HOUR);
  const [first] = w.gw(message.id).winners;

  await restart(w, w.time.now() + DAY);
  await w.cmd(w.admin, 'reroll', { message_id: message.id });
  assert.deepEqual(w.gw(message.id).rerolled, [first === a.id ? b.id : a.id]);

  await restart(w, w.time.now() + 31 * DAY);
  assert.equal(w.gw(message.id), undefined);
  assert.match(lastText(await w.cmd(w.admin, 'reroll', { message_id: message.id })), /kept for 30 days/);
});

test('a 30-day giveaway chains timers that fit in setTimeout', async () => {
  const w = world();
  const { message } = await w.start({ duration: '30d' });
  await w.press(w.member('alice'), message);
  assert.equal(w.time.delays[0], MAX_TIMER);

  await w.time.advance(MAX_TIMER);
  assert.equal(w.gw(message.id).status, 'running', 'still running after the first ~24.8 days');
  await w.time.advance(30 * DAY - MAX_TIMER - 1);
  assert.equal(w.gw(message.id).status, 'running');
  await w.time.advance(1);
  assert.equal(w.gw(message.id).status, 'ended');
  assert.equal(announcements(w.general).length, 1);
  assert.ok(w.time.delays.every(d => d <= MAX_TIMER));
});

// ---------- reroll / cancel / list ----------

test('reroll picks new winners and never repeats one', async () => {
  const w = world();
  const { message } = await w.start({ prize: 'Nitro' });
  const fans = ['a', 'b', 'c'].map(n => w.member(n));
  for (const f of fans) await w.press(f, message);
  await w.cmd(w.admin, 'end', { message_id: message.id });
  const [first] = w.gw(message.id).winners;

  const r1 = await w.cmd(w.admin, 'reroll', { message_id: message.id });
  const [second] = w.gw(message.id).rerolled;
  assert.notEqual(second, first);
  assert.match(lastText(r1), new RegExp(`Rerolled \\*\\*Nitro\\*\\*: <@${second}>`));
  const ann = announcements(w.general).at(-1);
  assert.deepEqual(ann.allowedMentions, { users: [second] });
  assert.match(ann.content, /New winner for \*\*Nitro\*\*/);
  assert.match(embedOf(lastEdit(message)).description, new RegExp(`Rerolled:\\*\\* <@${second}>`));

  const r2 = await w.cmd(w.admin, 'reroll', { message_id: message.id, winners: 3 });
  assert.match(lastText(r2), /Only 1 person was left/);
  assert.deepEqual(new Set([first, ...w.gw(message.id).rerolled]).size, 3);

  const r3 = await w.cmd(w.admin, 'reroll', { message_id: message.id });
  assert.match(lastText(r3), /nobody else/);
});

test('management commands need Manage Server and refuse the wrong state', async () => {
  const w = world();
  const alice = w.member('alice');
  const { message } = await w.start();
  for (const sub of ['end', 'reroll', 'cancel']) {
    const i = await w.cmd(alice, sub, { message_id: message.id });
    assert.match(lastText(i), /Manage Server/, sub);
  }
  assert.match(lastText(await w.cmd(w.admin, 'reroll', { message_id: message.id })), /still running/);
  assert.match(lastText(await w.cmd(w.admin, 'end', { message_id: 'not an id' })), /doesn't look like a message ID/);
  assert.match(lastText(await w.cmd(w.admin, 'end', { message_id: '123456' })), /don't have a giveaway/);
  assert.match(lastText(await w.cmd(w.admin, 'end', { message_id: `oops ${message.id}` })), /doesn't look like a message ID/);

  const link = `https://discord.com/channels/${w.guild.id}/${w.general.id}/${message.id}`;
  assert.match(lastText(await w.cmd(w.admin, 'cancel', { message_id: link })), /Cancelled the giveaway/);
  assert.match(lastText(await w.cmd(w.admin, 'end', { message_id: message.id })), /was cancelled/);
  assert.match(lastText(await w.cmd(w.admin, 'reroll', { message_id: message.id })), /was cancelled/);
  assert.match(lastText(await w.cmd(w.admin, 'cancel', { message_id: message.id })), /already been cancelled/);
});

test('giveaways from another server cannot be touched', async () => {
  const w = world();
  const other = world();
  const { message } = await other.start();
  const i = await w.cmd(w.admin, 'end', { message_id: message.id });
  assert.match(lastText(i), /don't have a giveaway/);
  assert.equal(other.gw(message.id).status, 'running');
});

test('cancel stops the giveaway without drawing anyone', async () => {
  const w = world();
  const { message } = await w.start();
  const alice = w.member('alice');
  for (let n = 0; n < 3; n++) await w.press(w.member(`fan${n}`), message); // leaves a count edit pending
  await w.cmd(w.admin, 'cancel', { message_id: message.id });

  const edit = lastEdit(message);
  assert.deepEqual(edit.components, []);
  assert.match(embedOf(edit).description, /was cancelled/);
  assert.equal(w.time.pending, 0, 'end timer and pending count edit cleared');
  await w.time.advance(DAY);
  assert.equal(lastEdit(message), edit, 'nothing edits it back');
  assert.equal(announcements(w.general).length, 0);
  assert.match(lastText(await w.press(alice, message)), /no longer running/);
});

test('list shows running giveaways with their IDs, and only where you can see them', async () => {
  const w = world();
  const alice = w.member('alice');
  assert.match(lastText(await w.cmd(alice, 'list')), /No giveaways are running/);

  const late = await w.start({ prize: 'Later', duration: '2d' });
  const soon = await w.start({ prize: 'Sooner', duration: '1h' });
  const done = await w.start({ prize: 'Finished', duration: '1h' });
  await w.cmd(w.admin, 'end', { message_id: done.message.id });
  const secret = w.guild.textChannel('staff-only');
  const hidden = await w.start({ prize: 'Staff prize', channel: secret });
  secret.permissionsFor = who => new PermissionsBitField(who === w.admin ? PermissionsBitField.All : 0n);

  const mine = await w.cmd(alice, 'list');
  assert.ok(isEphemeral(mine.calls[0][1]));
  const desc = embedOf(mine.calls[0][1]).description;
  assert.ok(desc.indexOf('Sooner') < desc.indexOf('Later'), 'soonest first');
  assert.match(desc, new RegExp(late.message.id));
  assert.match(desc, new RegExp(soon.message.id));
  assert.doesNotMatch(desc, /Finished/);
  assert.doesNotMatch(desc, /Staff prize/);

  const admins = embedOf((await w.cmd(w.admin, 'list')).calls[0][1]).description;
  assert.match(admins, new RegExp(hidden.message.id));
});

// ---------- safety ----------

test('prize text can never ping anyone but the winners', async () => {
  const w = world();
  const role = w.guild.makeRole('Everyone-ish', 2);
  const { message } = await w.start({ prize: `@everyone @here <@&${role.id}> free nitro` });
  const alice = w.member('alice');
  await w.press(alice, message);
  await w.cmd(w.admin, 'end', { message_id: message.id });
  const [ann] = announcements(w.general);
  assert.deepEqual(ann.allowedMentions, { users: [alice.id] });
});

test('embeds stay inside Discord limits with long prizes and many rerolls', async () => {
  const w = world();
  const prize = 'P'.repeat(200);
  const { message } = await w.start({ prize, winners: 20 });
  const fans = Array.from({ length: 30 }, (_, n) => w.member(`fan${n}`));
  for (const f of fans) await w.press(f, message);
  await w.cmd(w.admin, 'end', { message_id: message.id });
  const gw = w.gw(message.id);
  gw.rerolled.push(...Array.from({ length: 300 }, (_, n) => String(10n ** 18n + BigInt(n)))); // past rerolls with real-length IDs
  await w.cmd(w.admin, 'reroll', { message_id: message.id, winners: 5 });

  const embed = embedOf(lastEdit(message));
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 4096, `description is ${embed.description.length} chars`);
  assert.match(embed.description, /…and \d+ more/);
  for (const p of announcements(w.general)) assert.ok(p.content.length <= 2000);
});
