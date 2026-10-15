// Extra fake behavior /application needs on top of test/fakes.js: subcommand groups, guild.members.fetch
// (with members who left), and channel.messages.fetch({ message, force }).
const { PermissionFlagsBits: P } = require('discord.js');
const { makeGuild, command, button, modal, makeCtx } = require('./fakes');
const { Store } = require('../src/store');
const { buildRouter } = require('../src/router');

const apiError = (code, message) => Object.assign(new Error(message), { code });

function appGuild(opts) {
  const guild = makeGuild(opts);
  const members = new Map([[guild.me.id, guild.me], [guild.owner.id, guild.owner]]);
  const makeMember = guild.member;
  guild.member = (...args) => {
    const m = makeMember(...args);
    members.set(m.id, m);
    return m;
  };
  guild.members.fetch = async id => {
    if (!members.has(id)) throw apiError(10007, 'Unknown Member');
    return members.get(id);
  };
  guild.leave = member => members.delete(member.id);
  const textChannel = guild.textChannel;
  guild.textChannel = (...args) => {
    const ch = textChannel(...args);
    const fetch = ch.messages.fetch;
    ch.messages.fetch = arg => fetch(arg && typeof arg === 'object' && 'message' in arg ? arg.message : arg);
    return ch;
  };
  return guild;
}

// A fresh copy of the module, the way a restarted bot would load it (empty in-memory drafts and locks).
function loadApplication() {
  const file = require.resolve('../src/commands/application');
  delete require.cache[file];
  return require(file);
}

function world() {
  const ctx = makeCtx();
  const guild = appGuild({ botRolePosition: 10 });
  const modRole = guild.makeRole('Mod', 9);
  const reviewerRole = guild.makeRole('Reviewer', 4);
  const acceptRole = guild.makeRole('Staff', 3);
  return {
    ctx, guild, modRole, reviewerRole, acceptRole,
    general: guild.textChannel('general'),
    review: guild.textChannel('applications'),
    admin: guild.member('admin', { roles: [modRole], perms: P.ManageGuild | P.ManageRoles }),
    reviewer: guild.member('reviewer', { roles: [reviewerRole] }),
    alice: guild.member('alice'),
    bob: guild.member('bob'),
  };
}

// Same data file, new Store and a freshly loaded module: what the bot sees after a restart.
function restart(w) {
  w.ctx.store.flush();
  const app = loadApplication();
  const ctx = { ...w.ctx, store: new Store(w.ctx.store.file) };
  return { app, ctx, route: buildRouter([app]) };
}

function driver(w, app, { route = buildRouter([app]), ctx = () => w.ctx } = {}) {
  const run = async (i, extra = {}) => {
    Object.assign(i, extra);
    await route(i, ctx());
    return i;
  };
  return {
    run,
    cmd(member, subcommand, options = {}, { group = null, extra } = {}) {
      const i = command({ guild: w.guild, member, channel: w.general, commandName: 'application', subcommand, options });
      i.options.getSubcommandGroup = () => group;
      return run(i, extra);
    },
    question(member, subcommand, options) {
      return this.cmd(member, subcommand, options, { group: 'question' });
    },
    press(member, customId, { message = null, channel = w.general, extra } = {}) {
      return run(button({ guild: w.guild, member, channel, customId, message }), extra);
    },
    submit(member, customId, fields, { message = null, channel = w.general, extra } = {}) {
      return run(modal({ guild: w.guild, member, channel, customId, fields, message }), extra);
    },
  };
}

const formId = (w, name = 'Staff', ctx = w.ctx) =>
  Object.values(ctx.store.guild(w.guild.id).applications.forms).find(f => f.name === name)?.id;
const apps = (w, ctx = w.ctx) => Object.values(ctx.store.guild(w.guild.id).applications?.apps || {});

const shownModal = i => (i.calls[0]?.[0] === 'showModal' ? i.calls[0][1].toJSON() : null);
const inputs = json => json.components.map(c => c.component);
const lastComponents = i => (i.calls.at(-1)?.[1]?.components || []).flatMap(r => r.toJSON().components);
const posts = ch => ch.history.filter(m => m.author === ch.guild.botUser);
const reviewButtons = ch => posts(ch).filter(m => m.payload.components?.length);
const ids = msg => msg.payload.components.flatMap(r => r.toJSON().components.map(c => c.custom_id));
const answerFieldsOf = ch => posts(ch).flatMap(m => m.embeds.flatMap(e => e.fields || [])).filter(f => /^\d+\. /.test(f.name));

// Presses Apply and answers every page; returns the interaction that ended the flow.
async function applyAll(d, member, id, answer = n => `answer ${n + 1}`, { lastExtra } = {}) {
  let i = await d.press(member, `application:apply:${id}`);
  for (let guard = 0; guard < 20; guard++) {
    const json = shownModal(i);
    if (!json) return i;
    const fields = Object.fromEntries(inputs(json).map(c => [c.custom_id, answer(Number(c.custom_id.slice(1)))]));
    const sub = await d.submit(member, json.custom_id, fields, { extra: lastExtra });
    const next = lastComponents(sub)[0];
    if (!next || !next.custom_id.startsWith('application:resume:') || !next.label.startsWith('Continue')) return sub;
    i = await d.press(member, next.custom_id);
  }
  throw new Error('application flow did not finish');
}

async function makeForm(d, w, { name = 'Staff', questions = 3, style = 'short', ...options } = {}) {
  await d.cmd(w.admin, 'create', { name, review_channel: w.review, ...options });
  for (let n = 0; n < questions; n++) await d.question(w.admin, 'add', { form: name, text: `Question ${n + 1}?`, style });
  return formId(w, name);
}

const quietly = async fn => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

module.exports = {
  appGuild, loadApplication, world, restart, driver, formId, apps, shownModal, inputs, lastComponents, posts,
  reviewButtons, ids, answerFieldsOf, applyAll, makeForm, quietly, apiError,
};
