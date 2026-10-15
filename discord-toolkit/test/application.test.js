const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionFlagsBits: P } = require('discord.js');
const { lastText, isEphemeral, tick, PermissionsBitField } = require('./fakes');
const {
  world, restart, driver, formId, apps, shownModal, inputs, lastComponents, posts, reviewButtons, ids, answerFieldsOf,
  applyAll, makeForm, quietly,
} = require('./application-helpers');
const application = require('../src/commands/application');

const setup = () => {
  const w = world();
  return { w, d: driver(w, application) };
};
const acceptId = msg => ids(msg).find(id => id.startsWith('application:accept:'));
const denyId = msg => ids(msg).find(id => id.startsWith('application:deny:'));
const withoutPerms = (...perms) => new PermissionsBitField(PermissionsBitField.All).remove(P.Administrator, ...perms).bitfield;
const embedChars = e => (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.author?.name?.length ?? 0)
  + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

function assertWithinDiscordLimits(ch) {
  for (const m of posts(ch)) {
    assert.ok(m.embeds.length <= 10, `${m.embeds.length} embeds in one message`);
    assert.ok(m.embeds.reduce((n, e) => n + embedChars(e), 0) <= 6000, 'over 6000 embed characters in one message');
    for (const e of m.embeds) {
      assert.ok((e.fields || []).length <= 25);
      for (const f of e.fields || []) assert.ok(f.name.length <= 256 && f.value.length <= 1024 && f.value.trim().length > 0);
    }
    if (m.payload.components?.length) assert.deepEqual(m.payload.allowedMentions, { parse: [] });
  }
}

// ---------- setup ----------

test('the command definition builds and keeps required options first', () => {
  const json = application.data.toJSON();
  assert.deepEqual(json.contexts, [0]);
  const walk = opts => opts.forEach(o => {
    if (o.options) {
      const req = o.options.map(x => Boolean(x.required));
      assert.ok(req.indexOf(false) === -1 || !req.slice(req.indexOf(false)).includes(true), `${o.name}: required options first`);
      walk(o.options);
    }
  });
  walk(json.options);
  const add = json.options.find(o => o.name === 'question').options.find(o => o.name === 'add');
  const text = add.options.find(o => o.name === 'text');
  assert.equal(text.max_length, 45);
  assert.match(text.description, /45/);
});

test('admin subcommands are refused without Manage Server', async () => {
  const { w, d } = setup();
  for (const [sub, options, group] of [
    ['create', { name: 'Staff', review_channel: w.review }],
    ['edit', { form: 'Staff', description: 'x' }],
    ['panel', { form: 'Staff', channel: w.general }],
    ['delete', { form: 'Staff' }],
    ['add', { form: 'Staff', text: 'Why?', style: 'short' }, 'question'],
    ['list', { form: 'Staff' }, 'question'],
  ]) {
    const i = await d.cmd(w.alice, sub, options, { group });
    assert.match(lastText(i), /Manage Server/, sub);
    assert.ok(isEphemeral(i.calls[0][1]));
  }
  assert.deepEqual(w.ctx.store.guild(w.guild.id).applications, undefined, 'nothing stored');
});

test('create validates the name, roles and review channel', async () => {
  const { w, d } = setup();
  assert.match(lastText(await d.cmd(w.admin, 'create', { name: '   ', review_channel: w.review })), /Give the form a name/);
  assert.match(lastText(await d.cmd(w.admin, 'create', { name: 'Staff', review_channel: w.review, reviewer_role: w.guild.roles.everyone })), /not @everyone/);

  const high = w.guild.makeRole('Admin', 50);
  assert.match(lastText(await d.cmd(w.guild.owner, 'create', { name: 'Staff', review_channel: w.review, accept_role: high })), /has to be above \*\*Admin\*\*/);

  const managerOnly = w.guild.member('manager', { perms: P.ManageGuild });
  assert.match(lastText(await d.cmd(managerOnly, 'create', { name: 'Staff', review_channel: w.review, accept_role: w.acceptRole })), /Manage Roles/);
  const lowMod = w.guild.member('lowmod', { roles: [w.guild.makeRole('Helper', 2)], perms: P.ManageGuild | P.ManageRoles });
  assert.match(lastText(await d.cmd(lowMod, 'create', { name: 'Staff', review_channel: w.review, accept_role: w.acceptRole })), /below your own highest role/);

  w.review.botPerms = withoutPerms(P.AttachFiles);
  assert.match(lastText(await d.cmd(w.admin, 'create', { name: 'Staff', review_channel: w.review })), /Attach Files/);
  w.review.botPerms = PermissionsBitField.All;
  assert.equal(w.ctx.store.guild(w.guild.id).applications?.forms?.['1'], undefined, 'nothing created yet');

  const ok = await d.cmd(w.admin, 'create', { name: '  Staff   Team ', review_channel: w.review, accept_role: w.acceptRole, reviewer_role: w.reviewerRole, description: 'Line one\\nLine two' });
  assert.match(lastText(ok), /Created \*\*Staff Team\*\*/);
  assert.match(lastText(ok), /Everyone can see/);
  const form = w.ctx.store.guild(w.guild.id).applications.forms[formId(w, 'Staff Team')];
  assert.equal(form.description, 'Line one\nLine two');
  assert.equal(form.acceptRoleId, w.acceptRole.id);
  assert.equal(form.reviewerRoleId, w.reviewerRole.id);

  const dupe = await d.cmd(w.admin, 'create', { name: 'staff team', review_channel: w.review });
  assert.match(lastText(dupe), /already a form called \*\*Staff Team\*\*/);
});

test('create stops at 25 forms and skips the public warning for private channels', async () => {
  const { w, d } = setup();
  w.review.permissionsFor = who => new PermissionsBitField(who === w.guild.roles.everyone ? 0n : PermissionsBitField.All);
  const first = await d.cmd(w.admin, 'create', { name: 'Form 0', review_channel: w.review });
  assert.doesNotMatch(lastText(first), /Everyone can see/);
  for (let n = 1; n < 25; n++) await d.cmd(w.admin, 'create', { name: `Form ${n}`, review_channel: w.review });
  const over = await d.cmd(w.admin, 'create', { name: 'One more', review_channel: w.review });
  assert.match(lastText(over), /already has 25 forms/);
});

test('questions: add, insert, list, remove and their limits', async () => {
  const { w, d } = setup();
  const none = await d.question(w.admin, 'add', { form: 'Staff', text: 'Why?', style: 'short' });
  assert.match(lastText(none), /no application forms yet/);

  await d.cmd(w.admin, 'create', { name: 'Staff', review_channel: w.review });
  const unknown = await d.question(w.admin, 'list', { form: 'Mods' });
  assert.match(lastText(unknown), /no form called \*\*Mods\*\*.*\*\*Staff\*\*/);

  assert.match(lastText(await d.question(w.admin, 'add', { form: 'staff', text: '   ', style: 'short' })), /needs some text/);
  assert.match(lastText(await d.question(w.admin, 'add', { form: 'Staff', text: 'x'.repeat(46), style: 'short' })), /up to 45 characters/);

  await d.question(w.admin, 'add', { form: 'Staff', text: 'How old are you?', style: 'short' });
  await d.question(w.admin, 'add', { form: 'Staff', text: 'Why do you want to join?', style: 'paragraph', required: false });
  const inserted = await d.question(w.admin, 'add', { form: 'Staff', text: 'What is your name?', style: 'short', position: 1 });
  assert.match(lastText(inserted), /Added question 1/);
  const qs = w.ctx.store.guild(w.guild.id).applications.forms[formId(w)].questions;
  assert.deepEqual(qs.map(q => q.text), ['What is your name?', 'How old are you?', 'Why do you want to join?']);
  assert.deepEqual(qs[2], { text: 'Why do you want to join?', style: 'paragraph', required: false });

  const list = await d.question(w.admin, 'list', { form: 'Staff' });
  const desc = list.calls[0][1].embeds[0].toJSON().description;
  assert.match(desc, /\*\*1\.\*\* What is your name\? · short\n\*\*2\.\*\* How old are you\? · short\n\*\*3\.\*\* Why do you want to join\? · paragraph · optional/);

  assert.match(lastText(await d.question(w.admin, 'remove', { form: 'Staff', number: 4 })), /questions 1 to 3/);
  const removed = await d.question(w.admin, 'remove', { form: 'Staff', number: 1 });
  assert.match(lastText(removed), /Removed question 1 .*What is your name\?\nThe questions after it moved up/);
  assert.equal(qs[0].text, 'How old are you?');

  for (let n = qs.length; n < 40; n++) await d.question(w.admin, 'add', { form: 'Staff', text: `Q${n}`, style: 'short' });
  const full = await d.question(w.admin, 'add', { form: 'Staff', text: 'One too many', style: 'short' });
  assert.match(lastText(full), /already has 40 questions/);
  assert.equal(qs.length, 40);
});

test('panel posts an Apply button and warns about missing questions or review channel', async () => {
  const { w, d } = setup();
  await d.cmd(w.admin, 'create', { name: 'Staff', review_channel: w.review, description: 'Join the team' });
  const shop = w.guild.textChannel('apply-here');
  shop.botPerms = withoutPerms(P.SendMessages);
  assert.match(lastText(await d.cmd(w.admin, 'panel', { form: 'Staff', channel: shop })), /Send Messages/);
  assert.equal(posts(shop).length, 0);

  const i = await d.cmd(w.admin, 'panel', { form: 'Staff', channel: w.general });
  assert.match(lastText(i), /posted in/);
  assert.match(lastText(i), /no questions yet/);
  const panel = posts(w.general)[0];
  assert.equal(panel.embeds[0].description, 'Join the team');
  assert.deepEqual(ids(panel), [`application:apply:${formId(w)}`]);

  const press = await d.press(w.alice, `application:apply:${formId(w)}`);
  assert.match(lastText(press), /has no questions yet/);
  assert.ok(isEphemeral(press.calls[0][1]));

  await d.question(w.admin, 'add', { form: 'Staff', text: 'Why?', style: 'short' });
  await w.review.delete();
  const warn = await d.cmd(w.admin, 'panel', { form: 'Staff', channel: w.general });
  assert.match(lastText(warn), /review channel was deleted/);
});

// ---------- applying ----------

test('a short form opens one modal and posts every answer without pinging anyone', async () => {
  const { w, d } = setup();
  await d.cmd(w.admin, 'create', { name: 'Staff', review_channel: w.review });
  await d.question(w.admin, 'add', { form: 'Staff', text: 'Your name?', style: 'short' });
  await d.question(w.admin, 'add', { form: 'Staff', text: 'Why you?', style: 'paragraph' });
  await d.question(w.admin, 'add', { form: 'Staff', text: 'Anything else?', style: 'short', required: false });
  const id = formId(w);

  const open = await d.press(w.alice, `application:apply:${id}`);
  const json = shownModal(open);
  assert.equal(json.title, 'Staff');
  assert.deepEqual(json.components.map(c => c.label), ['Your name?', 'Why you?', 'Anything else?']);
  assert.deepEqual(inputs(json).map(c => [c.custom_id, c.style, c.required]), [['q0', 1, true], ['q1', 2, true], ['q2', 1, false]]);

  const done = await d.submit(w.alice, json.custom_id, { q0: 'Alice @everyone', q1: `I like <@&${w.modRole.id}> a lot`, q2: '   ' });
  assert.equal(done.calls[0][0], 'deferReply');
  assert.match(lastText(done), /application was sent/);

  const [post] = posts(w.review);
  assert.match(post.content, new RegExp(`application from <@${w.alice.id}>`));
  assert.deepEqual(post.payload.allowedMentions, { parse: [] });
  assert.equal(post.embeds[0].footer.text, `Application #1`);
  assert.deepEqual(answerFieldsOf(w.review).map(f => [f.name, f.value]), [
    ['1. Your name?', 'Alice @everyone'],
    ['2. Why you?', `I like <@&${w.modRole.id}> a lot`],
    ['3. Anything else?', '*No answer*'],
  ]);
  assert.deepEqual(ids(post), ['application:accept:1', 'application:deny:1']);
  assert.deepEqual(apps(w).map(a => [a.userId, a.status]), [[w.alice.id, 'pending']]);
});

test('a 40-question form goes page by page and posts once, inside Discord limits', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 40, style: 'paragraph' });

  const open = await d.press(w.alice, `application:apply:${id}`);
  const first = shownModal(open);
  assert.equal(first.title, 'Staff (1/8)');
  assert.equal(first.components.length, 5);
  assert.equal(first.components[0].description, 'Question 1 of 40');
  const page1 = await d.submit(w.alice, first.custom_id, { q0: 'a', q1: 'b', q2: 'c', q3: 'd', q4: 'e' });
  assert.match(lastText(page1), /Page 1 of 8 saved/);
  assert.ok(isEphemeral(page1.calls[0][1]));
  const next = lastComponents(page1)[0];
  assert.equal(next.label, 'Continue (page 2/8)');
  const second = shownModal(await d.press(w.alice, next.custom_id));
  assert.equal(second.title, 'Staff (2/8)');
  assert.deepEqual(inputs(second).map(c => c.custom_id), ['q5', 'q6', 'q7', 'q8', 'q9']);
  assert.equal(posts(w.review).length, 0, 'nothing posted before the last page');

  // finish from page 2 with ~250 characters per answer: several messages, but not enough for a .txt
  let i = await d.press(w.alice, next.custom_id);
  for (;;) {
    const json = shownModal(i);
    const sub = await d.submit(w.alice, json.custom_id, Object.fromEntries(inputs(json).map(c => [c.custom_id, `${c.custom_id} `.repeat(60)])));
    const btn = lastComponents(sub)[0];
    if (!btn) break;
    i = await d.press(w.alice, btn.custom_id);
  }
  assertWithinDiscordLimits(w.review);
  assert.ok(posts(w.review).length >= 2, 'split across messages');
  const numbers = new Set(answerFieldsOf(w.review).map(f => Number(f.name.split('.')[0])));
  assert.equal(numbers.size, 40, 'all 40 questions posted');
  assert.equal(reviewButtons(w.review).length, 1, 'one set of decision buttons');
  assert.equal(apps(w).length, 1);
});

test('long answers are split across fields and messages without losing a character', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 5, style: 'paragraph' });
  const words = Array.from({ length: 500 }, (_, n) => `word${n}`).join(' ');
  assert.ok(words.length <= 4000);
  const solid = '🙂'.repeat(1300) + 'x'.repeat(1400); // no spaces, emoji straddling the cut
  const answers = [words, solid, 'short', words.slice(0, 2500), solid.slice(0, 3999)];
  await applyAll(d, w.alice, id, n => answers[n]);

  assertWithinDiscordLimits(w.review);
  assert.ok(posts(w.review).length > 1 && posts(w.review).length <= 3, `${posts(w.review).length} messages`);
  const byQuestion = {};
  for (const f of answerFieldsOf(w.review)) (byQuestion[f.name.split('.')[0]] ||= []).push(f.value);
  assert.equal(byQuestion[1].join(' '), words);
  assert.equal(byQuestion[2].join(''), solid);
  assert.equal(byQuestion[3].join(''), 'short');
  assert.equal(byQuestion[5].join(''), solid.slice(0, 3999));
  assert.ok(!byQuestion[2].some(v => /^[\uDC00-\uDFFF]/.test(v)), 'no half emoji');
  const [last] = reviewButtons(w.review);
  assert.equal(last, posts(w.review).at(-1), 'buttons on the last part');
  assert.match(last.content, /part \d of \d/);
});

test('huge applications are attached as a .txt; without Attach Files they are split instead', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 40, style: 'paragraph' });
  const answer = n => `A${n}:` + 'z'.repeat(3990);
  await applyAll(d, w.alice, id, answer);
  const all = posts(w.review);
  assert.equal(all.length, 1);
  const file = all[0].payload.files[0];
  assert.equal(file.name, 'application-1.txt');
  const text = file.attachment.toString('utf8');
  for (let n = 0; n < 40; n++) assert.ok(text.includes(`${n + 1}. Question ${n + 1}?\n${answer(n)}`), `answer ${n + 1} in the file`);
  assert.match(all[0].embeds[0].description, /all 40 answers are in the attached file/);
  assert.deepEqual(ids(all[0]), ['application:accept:1', 'application:deny:1']);

  w.review.botPerms = withoutPerms(P.AttachFiles);
  await applyAll(d, w.bob, id, answer);
  const bobs = posts(w.review).slice(1);
  assert.ok(bobs.length > 3, 'split into many messages');
  assert.ok(bobs.every(m => !m.payload.files));
  const joined = {};
  for (const m of bobs) for (const e of m.embeds) for (const f of e.fields || []) if (/^\d+\. /.test(f.name)) joined[f.name.split('.')[0]] = (joined[f.name.split('.')[0]] || '') + f.value;
  for (let n = 0; n < 40; n++) assert.equal(joined[n + 1], answer(n));
  assert.equal(reviewButtons(w.review).at(-1), bobs.at(-1));
});

test('a blank required answer re-asks that page with the other answers kept', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 2 });
  const json = shownModal(await d.press(w.alice, `application:apply:${id}`));
  const blank = await d.submit(w.alice, json.custom_id, { q0: 'kept', q1: '    ' });
  assert.match(lastText(blank), /Question 2 needs an answer/);
  const retry = lastComponents(blank)[0];
  assert.equal(retry.label, 'Answer page 1 again');
  const again = shownModal(await d.press(w.alice, retry.custom_id));
  assert.equal(again.custom_id, json.custom_id, 'same page');
  assert.equal(inputs(again)[0].value, 'kept');
  assert.equal(inputs(again)[1].value, undefined);
  await d.submit(w.alice, again.custom_id, { q0: 'kept', q1: 'now answered' });
  assert.equal(apps(w).length, 1);
});

test('a second application is blocked while one is pending; a deleted review post unblocks it', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w);
  await applyAll(d, w.alice, id);
  const again = await d.press(w.alice, `application:apply:${id}`);
  assert.match(lastText(again), /already applied for \*\*Staff\*\*/);
  assert.equal(again.calls[0][0], 'reply');

  await w.review.messages.delete(posts(w.review)[0].id); // a mod removed the post by hand
  const fresh = await d.press(w.alice, `application:apply:${id}`);
  assert.ok(shownModal(fresh), 'can apply again');
  assert.equal(apps(w).length, 0, 'stale record dropped');
});

test('someone who already has the accept role is told so', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { accept_role: w.acceptRole });
  await w.alice.roles.add(w.acceptRole);
  assert.match(lastText(await d.press(w.alice, `application:apply:${id}`)), /already have/);
});

test('double clicks: Apply twice shares one draft, the last page twice posts once', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 2 });
  const [a, b] = await Promise.all([d.press(w.alice, `application:apply:${id}`), d.press(w.alice, `application:apply:${id}`)]);
  assert.equal(shownModal(a).custom_id, shownModal(b).custom_id);
  const custom = shownModal(a).custom_id;
  const fields = { q0: 'x', q1: 'y' };
  const [s1, s2] = await Promise.all([d.submit(w.alice, custom, fields), d.submit(w.alice, custom, fields)]);
  assert.equal(posts(w.review).length, 1);
  assert.equal(apps(w).length, 1);
  assert.ok([lastText(s1), lastText(s2)].some(t => /already saved/.test(t)));
});

test('unfinished applications expire and stale modals are rejected', async () => {
  const { w, d } = setup();
  w.ctx.applicationDraftTtlMs = 20;
  const id = await makeForm(d, w, { questions: 7 });
  const first = shownModal(await d.press(w.alice, `application:apply:${id}`));
  const page1 = await d.submit(w.alice, first.custom_id, { q0: 'a', q1: 'b', q2: 'c', q3: 'd', q4: 'e' });
  const cont = lastComponents(page1)[0].custom_id;
  const second = shownModal(await d.press(w.alice, cont));
  await tick(30);
  assert.match(lastText(await d.press(w.alice, cont)), /expired/);
  assert.match(lastText(await d.submit(w.alice, second.custom_id, { q5: 'f', q6: 'g' })), /expired/);

  w.ctx.applicationDraftTtlMs = 60_000;
  const restarted = shownModal(await d.press(w.alice, `application:apply:${id}`));
  assert.equal(restarted.title, 'Staff (1/2)');
  assert.notEqual(restarted.custom_id, first.custom_id, 'a new draft');
  // a modal left open from the expired draft must not write into the new one
  assert.match(lastText(await d.submit(w.alice, first.custom_id, { q0: 'old', q1: 'old', q2: 'old', q3: 'old', q4: 'old' })), /expired/);
  assert.equal(posts(w.review).length, 0);
  assert.equal(apps(w).length, 0);
});

test('questions edited mid-application do not shift answers', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 6 });
  const first = shownModal(await d.press(w.alice, `application:apply:${id}`));
  const page1 = await d.submit(w.alice, first.custom_id, { q0: 'one', q1: 'two', q2: 'three', q3: 'four', q4: 'five' });
  await d.question(w.admin, 'remove', { form: 'Staff', number: 1 });
  const second = shownModal(await d.press(w.alice, lastComponents(page1)[0].custom_id));
  assert.deepEqual(second.components.map(c => c.label), ['Question 6?']);
  await d.submit(w.alice, second.custom_id, { q5: 'six' });
  assert.deepEqual(answerFieldsOf(w.review).map(f => `${f.name}=${f.value}`), [
    '1. Question 1?=one', '2. Question 2?=two', '3. Question 3?=three', '4. Question 4?=four', '5. Question 5?=five', '6. Question 6?=six',
  ]);
});

// ---------- restarts ----------

test('a restart mid-application cannot post a half-filled application', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 7 });
  const first = shownModal(await d.press(w.alice, `application:apply:${id}`));
  const page1 = await d.submit(w.alice, first.custom_id, { q0: 'a', q1: 'b', q2: 'c', q3: 'd', q4: 'e' });
  const cont = lastComponents(page1)[0].custom_id;
  const second = shownModal(await d.press(w.alice, cont));

  const r = restart(w);
  const d2 = driver(w, r.app, { route: r.route, ctx: () => r.ctx });
  assert.match(lastText(await d2.submit(w.alice, second.custom_id, { q5: 'f', q6: 'g' })), /expired.*restarts/);
  assert.match(lastText(await d2.press(w.alice, cont)), /expired/);
  assert.equal(posts(w.review).length, 0);
  assert.equal(apps(w, r.ctx).length, 0);
  const again = shownModal(await d2.press(w.alice, `application:apply:${id}`));
  assert.equal(again.title, 'Staff (1/2)');
});

test('pending applications survive a restart and can still be decided', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { accept_role: w.acceptRole, reviewer_role: w.reviewerRole });
  await applyAll(d, w.alice, id);
  const [post] = reviewButtons(w.review);

  const r = restart(w);
  const d2 = driver(w, r.app, { route: r.route, ctx: () => r.ctx });
  const blocked = await d2.press(w.alice, `application:apply:${id}`);
  assert.match(lastText(blocked), /already applied/);
  const ok = await d2.press(w.reviewer, acceptId(post), { message: post });
  assert.match(lastText(ok), /Accepted/);
  assert.ok(w.alice.roles.cache.has(w.acceptRole.id));
  assert.equal(apps(w, r.ctx)[0].status, 'accepted');
});

test('onReady takes down a review post that a restart cut short', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 5, style: 'paragraph' });
  const send = w.review.send;
  let sent = 0;
  w.review.send = payload => (++sent === 2 ? new Promise(() => {}) : send(payload)); // the bot dies while posting part 2
  const first = shownModal(await d.press(w.alice, `application:apply:${id}`));
  d.submit(w.alice, first.custom_id, Object.fromEntries(inputs(first).map(c => [c.custom_id, 'y'.repeat(2000)])));
  await tick();
  assert.equal(posts(w.review).length, 1, 'first part posted');

  const r = restart(w);
  assert.equal(Object.keys(r.ctx.store.guild(w.guild.id).applications.posting).length, 1);
  await r.app.onReady({ guilds: { cache: new Collection([[w.guild.id, w.guild]]) } }, r.ctx);
  assert.equal(posts(w.review).length, 0, 'partial post removed');
  assert.deepEqual(r.ctx.store.guild(w.guild.id).applications.posting, {});
  assert.equal(apps(w, r.ctx).length, 0);
  const d2 = driver(w, r.app, { route: r.route, ctx: () => r.ctx });
  assert.ok(shownModal(await d2.press(w.alice, `application:apply:${id}`)), 'free to apply again');
});

test('onReady is harmless with no applications data or a guild the bot left', async () => {
  const { w } = setup();
  const g = w.ctx.store.guild('gone-guild');
  g.applications = { posting: { 7: { channelId: '1', messageIds: ['2'] } } };
  w.ctx.store.guild(w.guild.id);
  await application.onReady({ guilds: { cache: new Collection() } }, w.ctx);
  assert.deepEqual(g.applications.posting, {});
});

// ---------- failures while sending ----------

test('a deleted review channel: apply explains, a failed send keeps answers for Try again', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 2 });
  const json = shownModal(await d.press(w.alice, `application:apply:${id}`));
  await w.review.delete();
  const failed = await d.submit(w.alice, json.custom_id, { q0: 'a', q1: 'b' });
  assert.match(lastText(failed), /couldn't send your application: the review channel was deleted/);
  const retry = lastComponents(failed)[0];
  assert.equal(retry.label, 'Try again');
  assert.equal(apps(w).length, 0);

  assert.match(lastText(await d.press(w.bob, `application:apply:${id}`)), /can't be sent right now: the review channel was deleted/);

  const newReview = w.guild.textChannel('new-review');
  await d.cmd(w.admin, 'edit', { form: 'Staff', review_channel: newReview });
  const sent = await d.press(w.alice, retry.custom_id);
  assert.match(lastText(sent), /was sent/);
  assert.deepEqual(answerFieldsOf(newReview).map(f => f.value), ['a', 'b']);
  assert.match(lastText(await d.press(w.alice, retry.custom_id)), /already sent/);
});

test('a send that fails half way removes the parts already posted', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 5, style: 'paragraph' });
  const send = w.review.send;
  let sent = 0;
  w.review.send = payload => (++sent === 2 ? Promise.reject(new Error('Missing Access')) : send(payload));
  const json = shownModal(await d.press(w.alice, `application:apply:${id}`));
  const failed = await quietly(() => d.submit(w.alice, json.custom_id, Object.fromEntries(inputs(json).map(c => [c.custom_id, 'y'.repeat(2000)]))));
  assert.match(lastText(failed), /posting in the review channel failed/);
  assert.equal(posts(w.review).length, 0, 'first part deleted again');
  assert.deepEqual(w.ctx.store.guild(w.guild.id).applications.posting, {});
  assert.equal(apps(w).length, 0);
  w.review.send = send;
  assert.match(lastText(await d.press(w.alice, lastComponents(failed)[0].custom_id)), /was sent/);
});

// ---------- reviewing ----------

test('accept gives the role, DMs the applicant, closes the post; a second click is harmless', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { accept_role: w.acceptRole, reviewer_role: w.reviewerRole });
  await applyAll(d, w.alice, id);
  const [post] = reviewButtons(w.review);

  const stranger = await d.press(w.bob, acceptId(post), { message: post });
  assert.match(lastText(stranger), new RegExp(`Only <@&${w.reviewerRole.id}> and people with \\*\\*Manage Server\\*\\*`));
  assert.equal(post.edits.length, 0);

  const ok = await d.press(w.reviewer, acceptId(post), { message: post });
  assert.ok(isEphemeral(ok.calls[0][1]));
  assert.match(lastText(ok), /Accepted <@\d+>'s \*\*Staff\*\* application; gave them/);
  assert.ok(w.alice.roles.cache.has(w.acceptRole.id));
  assert.equal(ok.dms[0].userId, w.alice.id);
  assert.match(ok.dms[0].payload.content, /was accepted!.*\*\*Staff\*\* role/);
  const edit = post.edits.at(-1);
  assert.match(edit.content, new RegExp(`Accepted\\*\\* by <@${w.reviewer.id}>`));
  assert.deepEqual(edit.components, []);
  assert.deepEqual(edit.allowedMentions, { parse: [] });

  const second = await d.press(w.admin, acceptId(post), { message: post });
  assert.match(lastText(second), new RegExp(`already accepted by <@${w.reviewer.id}>`));
  assert.equal(second.dms.length, 0);
  const denyAfter = await d.press(w.admin, denyId(post), { message: post });
  assert.match(lastText(denyAfter), /already accepted/);
  assert.equal(denyAfter.calls[0][0], 'reply', 'no modal for a decided application');

  const status = await d.cmd(w.alice, 'status');
  assert.match(status.calls.at(-1)[1].embeds[0].toJSON().description, /✅ \*\*Staff\*\*: accepted/);
});

test('deny asks for a reason, sends it, and reports closed DMs', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w);
  await applyAll(d, w.alice, id);
  const [post] = reviewButtons(w.review);
  const ask = await d.press(w.admin, denyId(post), { message: post });
  const json = shownModal(ask);
  assert.equal(json.custom_id, denyId(post));
  assert.equal(inputs(json)[0].required, false);

  const reason = 'Not enough detail @everyone';
  const done = await d.submit(w.admin, json.custom_id, { reason: `  ${reason}  ` }, { extra: { dmFails: true } });
  assert.match(lastText(done), /Denied .*DMs are closed.*\/application status/);
  const edit = post.edits.at(-1);
  assert.match(edit.content, /Denied\*\* by .*couldn't DM them\n\*\*Reason:\*\* Not enough detail @everyone/);
  assert.deepEqual(edit.allowedMentions, { parse: [] });
  assert.equal(apps(w)[0].reason, reason);

  const status = await d.cmd(w.alice, 'status', { form: 'staff' });
  assert.match(status.calls.at(-1)[1].embeds[0].toJSON().description, /❌ \*\*Staff\*\*: denied .*\n\*\*Reason:\*\* Not enough detail/);
  assert.ok(shownModal(await d.press(w.alice, `application:apply:${id}`)), 'can apply again after a denial');
});

test('deny without a reason DMs a plain result', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w);
  await applyAll(d, w.alice, id);
  const [post] = reviewButtons(w.review);
  const done = await d.submit(w.admin, denyId(post), { reason: '' });
  assert.equal(done.dms[0].payload.content, `Your **Staff** application in **Test Server** was denied.`);
  assert.deepEqual(done.dms[0].payload.allowedMentions, { parse: [] });
  assert.doesNotMatch(post.edits.at(-1).content, /Reason/);
});

test('accept and deny at the same moment: only one decision sticks', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { accept_role: w.acceptRole, reviewer_role: w.reviewerRole });
  await applyAll(d, w.alice, id);
  const [post] = reviewButtons(w.review);
  const [a, b] = await Promise.all([
    d.press(w.reviewer, acceptId(post), { message: post }),
    d.submit(w.admin, denyId(post), { reason: 'no' }),
  ]);
  assert.match(lastText(b), /Another reviewer is deciding/);
  assert.match(lastText(a), /Accepted/);
  assert.equal(apps(w)[0].status, 'accepted');
  assert.equal(a.dms.length + b.dms.length, 1);
});

test('reviewers cannot decide on their own application', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { reviewer_role: w.reviewerRole });
  await applyAll(d, w.reviewer, id);
  const [post] = reviewButtons(w.review);
  assert.match(lastText(await d.press(w.reviewer, acceptId(post), { message: post })), /your own application/);
  assert.match(lastText(await d.press(w.reviewer, denyId(post), { message: post })), /your own application/);
  assert.equal(apps(w)[0].status, 'pending');
});

test('accept is refused, not half-done, when the role cannot be given', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { accept_role: w.acceptRole });
  await applyAll(d, w.alice, id);
  const [post] = reviewButtons(w.review);
  const press = () => d.press(w.admin, acceptId(post), { message: post });

  w.acceptRole.position = 50;
  const above = await press();
  assert.match(lastText(above), /can't accept this yet: My highest role has to be above \*\*Staff\*\*/);
  assert.equal(above.dms.length, 0);
  w.acceptRole.position = 3;

  const add = w.alice.roles.add;
  w.alice.roles.add = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
  const failed = await quietly(press);
  assert.match(lastText(failed), /couldn't give .*nothing was changed/);
  w.alice.roles.add = add;

  w.guild.roles.cache.delete(w.acceptRole.id);
  const gone = await press();
  assert.match(lastText(gone), /no longer exists.*\/application edit/);
  assert.equal(apps(w)[0].status, 'pending');
  assert.equal(post.edits.length, 0);

  await d.cmd(w.admin, 'edit', { form: 'Staff', remove: 'accept_role' });
  const ok = await press();
  assert.match(lastText(ok), /Accepted/);
  assert.equal(apps(w)[0].status, 'accepted');
});

test('Manage Server alone cannot hand out a role its holder could not give, directly or by picking reviewers', async () => {
  const { w, d } = setup();
  const managerOnly = w.guild.member('manager', { perms: P.ManageGuild });
  const id = await makeForm(d, w, { accept_role: w.acceptRole, reviewer_role: w.reviewerRole });
  await applyAll(d, w.alice, id);
  const [post] = reviewButtons(w.review);

  const blocked = await d.press(managerOnly, acceptId(post), { message: post });
  assert.match(lastText(blocked), /can't accept this one: You need the \*\*Manage Roles\*\* permission.*someone with <@&\d+>/);
  assert.equal(w.alice.roles.cache.has(w.acceptRole.id), false);
  assert.equal(apps(w)[0].status, 'pending');
  assert.equal(post.edits.length, 0);

  const everyoneRole = w.guild.makeRole('Members', 1);
  const reroute = await d.cmd(managerOnly, 'edit', { form: 'Staff', reviewer_role: everyoneRole });
  assert.match(lastText(reroute), /Manage Roles/);
  assert.equal(w.ctx.store.guild(w.guild.id).applications.forms[id].reviewerRoleId, w.reviewerRole.id);

  const denied = await d.submit(managerOnly, denyId(post), { reason: '' });
  assert.match(lastText(denied), /Denied/, 'denying hands out nothing, so Manage Server is enough');

  const noRole = await makeForm(d, w, { name: 'Whitelist', questions: 1 });
  await applyAll(d, w.bob, noRole);
  const bobPost = reviewButtons(w.review).at(-1);
  assert.match(lastText(await d.press(managerOnly, acceptId(bobPost), { message: bobPost })), /Accepted/);
});

test('accepting someone who left the server still records the decision', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { accept_role: w.acceptRole });
  await applyAll(d, w.alice, id);
  const [post] = reviewButtons(w.review);
  w.guild.leave(w.alice);
  const ok = await d.press(w.admin, acceptId(post), { message: post, extra: { dmFails: true } });
  assert.match(lastText(ok), /left the server/);
  assert.equal(apps(w)[0].status, 'accepted');
  assert.match(post.edits.at(-1).content, /left the server.*couldn't DM them/);
});

test('a lost decision edit is repaired by the next click, and a deleted post does not crash a decision', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w);
  await applyAll(d, w.alice, id);
  const [post] = reviewButtons(w.review);
  await w.review.messages.delete(post.id);
  const ok = await d.submit(w.admin, denyId(post), { reason: '' });
  assert.match(lastText(ok), /Denied/);
  assert.equal(apps(w)[0].status, 'denied');

  const stale = await d.press(w.admin, acceptId(post), { message: post });
  assert.match(lastText(stale), /already denied/);
  assert.deepEqual(post.edits.at(-1), { components: [] }, 'leftover buttons cleared');
});

// ---------- edit / delete / status ----------

test('edit changes settings, refreshes panels and validates like create', async () => {
  const { w, d } = setup();
  await makeForm(d, w, { reviewer_role: w.reviewerRole });
  await d.cmd(w.admin, 'panel', { form: 'Staff', channel: w.general });
  const panel = posts(w.general)[0];

  assert.match(lastText(await d.cmd(w.admin, 'edit', { form: 'Staff' })), /Nothing to change/);
  assert.match(lastText(await d.cmd(w.admin, 'edit', { form: 'Staff', accept_role: w.acceptRole, remove: 'accept_role' })), /set and remove/);
  const lowMod = w.guild.member('lowmod', { roles: [w.guild.makeRole('Helper', 2)], perms: P.ManageGuild | P.ManageRoles });
  assert.match(lastText(await d.cmd(lowMod, 'edit', { form: 'Staff', accept_role: w.acceptRole })), /below your own highest role/);
  assert.match(lastText(await d.cmd(w.admin, 'edit', { form: 'Staff', reviewer_role: w.guild.roles.everyone })), /not @everyone/);

  const ok = await d.cmd(w.admin, 'edit', { form: 'Staff', description: 'New text', remove: 'reviewer_role' });
  assert.match(lastText(ok), /Updated \*\*Staff\*\*/);
  assert.match(lastText(ok), /Reviewers: anyone with \*\*Manage Server\*\*/);
  assert.equal(panel.edits.at(-1).embeds[0].toJSON().description, 'New text');

  await applyAll(d, w.alice, formId(w));
  const [post] = reviewButtons(w.review);
  assert.match(lastText(await d.press(w.reviewer, acceptId(post), { message: post })), /Only people with \*\*Manage Server\*\*/);
});

test('delete asks first, then removes the form, its panels, pending applications and drafts', async () => {
  const { w, d } = setup();
  const id = await makeForm(d, w, { questions: 6 });
  await d.cmd(w.admin, 'panel', { form: 'Staff', channel: w.general });
  await applyAll(d, w.alice, id);
  const [post] = reviewButtons(w.review);
  const bobModal = shownModal(await d.press(w.bob, `application:apply:${id}`));

  const ask = await d.cmd(w.admin, 'delete', { form: 'STAFF' });
  assert.match(lastText(ask), /Delete \*\*Staff\*\* with its 6 questions and 1 pending application\?/);
  const confirmId = lastComponents(ask)[0].custom_id;
  assert.match(lastText(await d.press(w.alice, confirmId)), /Manage Server/);
  assert.ok(formId(w));

  const done = await d.press(w.admin, confirmId);
  assert.equal(done.calls[0][0], 'update');
  assert.match(lastText(done), /Deleted \*\*Staff\*\*/);
  assert.equal(formId(w), undefined);
  assert.equal(posts(w.general).length, 0, 'panel removed');
  assert.equal(apps(w).length, 0);

  assert.match(lastText(await d.press(w.admin, confirmId)), /already deleted/);
  assert.match(lastText(await d.submit(w.bob, bobModal.custom_id, { q0: 'a', q1: 'b', q2: 'c', q3: 'd', q4: 'e' })), /expired/);
  const stale = await d.press(w.admin, acceptId(post), { message: post });
  assert.match(lastText(stale), /no longer open for review/);
  assert.deepEqual(post.edits.at(-1), { components: [] });
  assert.match(lastText(await d.press(w.alice, `application:apply:${id}`)), /no longer exists/);
});

test('status shows the caller their own drafts, pending and decided applications', async () => {
  const { w, d } = setup();
  assert.match(lastText(await d.cmd(w.alice, 'status')), /haven't applied for anything/);
  const staff = await makeForm(d, w, { name: 'Staff', questions: 7 });
  await makeForm(d, w, { name: 'Whitelist', questions: 1 });
  assert.match(lastText(await d.cmd(w.alice, 'status', { form: 'nope' })), /no form called/);
  assert.match(lastText(await d.cmd(w.alice, 'status', { form: 'Staff' })), /haven't applied for \*\*Staff\*\*/);

  const first = shownModal(await d.press(w.alice, `application:apply:${staff}`));
  await d.submit(w.alice, first.custom_id, { q0: 'a', q1: 'b', q2: 'c', q3: 'd', q4: 'e' });
  await applyAll(d, w.alice, formId(w, 'Whitelist'));
  const mine = (await d.cmd(w.alice, 'status')).calls.at(-1)[1].embeds[0].toJSON().description;
  assert.match(mine, /📝 \*\*Staff\*\*: not sent yet \(1 of 2 pages answered\)/);
  assert.match(mine, /⏳ \*\*Whitelist\*\*: sent <t:\d+:R>, waiting/);
  assert.match(lastText(await d.cmd(w.bob, 'status')), /haven't applied for anything/);
});

// ---------- helpers ----------

test('chunkText respects the limit and keeps every character', () => {
  const { chunkText } = application;
  assert.deepEqual(chunkText('short', 10), ['short']);
  assert.deepEqual(chunkText('aaaa bbbb cccc', 10), ['aaaa bbbb', 'cccc']);
  assert.deepEqual(chunkText('line one\nline two', 12), ['line one', 'line two']);
  const emoji = 'x' + '😀'.repeat(10);
  const parts = chunkText(emoji, 4);
  assert.ok(parts.every(p => p.length <= 4));
  assert.equal(parts.join(''), emoji);
  assert.ok(parts.every(p => !/^[\uDC00-\uDFFF]/.test(p)));
});
