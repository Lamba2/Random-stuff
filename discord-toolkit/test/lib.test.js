const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseDice, rollDice, channelName, stars, roleProblem } = require('../src/lib/util');
const { formatTranscript, fetchHistory } = require('../src/lib/transcript');
const { Store } = require('../src/store');
const { parseColor } = require('../src/config');
const { makeGuild, tempStore, PermissionsBitField } = require('./fakes');
const { commands } = require('../src/commands');

test('every command definition is valid and required options come first', () => {
  const names = new Set();
  for (const c of commands) {
    const json = c.data.toJSON();
    assert.ok(!names.has(json.name), `duplicate command ${json.name}`);
    names.add(json.name);
    assert.deepEqual(json.contexts, [0], `${json.name} is guild-only`);
    const check = opts => {
      let seenOptional = false;
      for (const o of opts || []) {
        if (o.type === 1) { check(o.options); continue; } // subcommand
        if (!o.required) seenOptional = true;
        else assert.ok(!seenOptional, `${json.name}: required option ${o.name} after an optional one`);
      }
    };
    check(json.options);
    assert.equal(typeof c.execute, 'function');
  }
});

test('parseDice', () => {
  assert.deepEqual(parseDice('d20'), { count: 1, sides: 20, modifier: 0 });
  assert.deepEqual(parseDice(' 2d6 + 3 '), { count: 2, sides: 6, modifier: 3 });
  assert.deepEqual(parseDice('4D8-1'), { count: 4, sides: 8, modifier: -1 });
  for (const bad of ['', 'd1', '0d6', '51d6', '2d1001', 'abc', '2d6+', '2d6*2', null]) assert.equal(parseDice(bad), null, String(bad));
});

test('rollDice stays in range', () => {
  const lo = rollDice({ count: 3, sides: 6, modifier: 2 }, () => 0);
  assert.deepEqual(lo, { rolls: [1, 1, 1], total: 5 });
  const hi = rollDice({ count: 2, sides: 6, modifier: 0 }, () => 0.999999);
  assert.deepEqual(hi, { rolls: [6, 6], total: 12 });
});

test('channelName and stars', () => {
  assert.equal(channelName('ticket-0001-Alice.Smith'), 'ticket-0001-alice-smith');
  assert.equal(channelName('ticket-0002-___'), 'ticket-0002-___');
  assert.equal(channelName('!!!'), 'ticket');
  assert.ok(channelName('x'.repeat(300)).length <= 90);
  assert.equal(stars(3), '★★★☆☆');
});

test('roleProblem covers each failure', () => {
  const g = makeGuild({ botRolePosition: 10 });
  const me = g.me;
  assert.match(roleProblem(null, me), /no longer exists/);
  assert.match(roleProblem(g.roles.everyone, me), /@everyone/);
  assert.match(roleProblem(g.makeRole('Integration', 1, { managed: true }), me), /bot or integration/);
  assert.match(roleProblem(g.makeRole('Same', 10), me), /has to be above/);
  assert.equal(roleProblem(g.makeRole('Low', 3), me), null);
  me.permissions = new PermissionsBitField(0n);
  assert.match(roleProblem(g.makeRole('Low2', 3), me), /Manage Roles/);
});

test('parseColor', () => {
  assert.equal(parseColor('#ff0000'), 0xff0000);
  assert.equal(parseColor('00ff00'), 0x00ff00);
  assert.equal(parseColor('red'), 0x5865f2);
  assert.equal(parseColor(undefined), 0x5865f2);
});

test('fetchHistory pages through long channels and returns oldest first', async () => {
  const g = makeGuild();
  const ch = g.textChannel('long');
  const u = { tag: 'alice', bot: false };
  for (let i = 0; i < 250; i++) ch.post(u, `msg ${i}`);
  const all = await fetchHistory(ch);
  assert.equal(all.length, 250);
  assert.equal(all[0].content, 'msg 0');
  assert.equal(all[249].content, 'msg 249');
  const capped = await fetchHistory(ch, 120);
  assert.equal(capped.length, 120);
});

test('formatTranscript includes embeds, attachments and the intent hint', () => {
  const { Collection } = require('discord.js');
  const msgs = [
    { author: { tag: 'alice', bot: false }, content: 'hi', embeds: [], attachments: new Collection(), createdTimestamp: 0 },
    { author: { tag: 'bot', bot: true }, content: '', embeds: [{ title: 'Ticket #1', description: 'Tell us\nwhat you need' }], attachments: new Collection(), createdTimestamp: 1000 },
    { author: { tag: 'bob', bot: false }, content: '', embeds: [], attachments: new Collection([['1', { name: 'proof.png', url: 'https://cdn/x.png' }]]), createdTimestamp: 2000 },
    { author: { tag: 'carol', bot: false }, content: '', embeds: [], attachments: new Collection(), createdTimestamp: 3000 },
  ];
  const text = formatTranscript(msgs, { guildName: 'S', channelName: 'ticket-0001', title: 'T' });
  assert.match(text, /\[1970-01-01 00:00:00 UTC\] alice: hi/);
  assert.match(text, /bot \[bot\]: \[embed\] Ticket #1 - Tell us what you need/);
  assert.match(text, /bob: \[attachment\] proof\.png https:\/\/cdn\/x\.png/);
  assert.match(text, /carol: \(no visible content\)/);
  assert.match(text, /Message Content Intent/);
});

test('store persists, fills new sections in place, and survives a corrupt file', () => {
  const { store, dir } = tempStore();
  const g = store.guild('1');
  const tickets = g.tickets;
  delete g.stock; // simulate data from an older version
  const again = store.guild('1');
  assert.equal(again.tickets, tickets, 'existing objects are kept, not replaced');
  assert.deepEqual(again.stock, { items: {}, panel: null, notifyRoleId: null });
  again.tickets.counter = 7;
  store.flush();

  const reloaded = new Store(store.file);
  assert.equal(reloaded.guild('1').tickets.counter, 7);

  fs.writeFileSync(store.file, '{ not json');
  const orig = console.error;
  console.error = () => {};
  try {
    const recovered = new Store(store.file);
    assert.deepEqual(recovered.data, { guilds: {} });
  } finally {
    console.error = orig;
  }
  const backups = fs.readdirSync(dir).filter(f => f.includes('.broken-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{ not json');
});

test('store.save debounces into one write', async () => {
  const { store } = tempStore();
  store.guild('1').tickets.counter = 1;
  store.save();
  store.guild('1').tickets.counter = 2;
  store.save();
  assert.equal(fs.existsSync(store.file), false, 'not written synchronously');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).guilds['1'].tickets.counter, 2);
});
