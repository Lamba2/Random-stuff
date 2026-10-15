const {
  SlashCommandBuilder, InteractionContextType, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags, RESTJSONErrorCodes,
  PermissionFlagsBits: P,
} = require('discord.js');
const { ephemeral, isAdmin, botMember, roleProblem, grantProblem, cantPost } = require('../lib/util');

const MAX_FORMS = 25;
const MAX_QUESTIONS = 40;
const PER_PAGE = 5; // Discord allows 5 inputs per modal
const NAME_MAX = 32; // leaves room for " (8/8)" in the 45-character modal title
const LABEL_MAX = 45;
const ANSWER_MAX = { short: 1000, paragraph: 4000 };
const REASON_MAX = 1000;
const DRAFT_TTL = 30 * 60 * 1000;
const MAX_REVIEW_MESSAGES = 3; // longer applications go in a .txt instead of flooding the review channel
const MESSAGE_CHARS = 6000;
const KEEP_DECIDED = 500;
const MAX_PANELS = 5;
const EXPIRED = 'Your unfinished application expired. Answers are kept for 30 minutes and are cleared if the bot restarts. Press **Apply** to start again.';

const formOption = o => o.setName('form').setDescription('Form name').setRequired(true).setMaxLength(NAME_MAX);

const data = new SlashCommandBuilder()
  .setName('application')
  .setDescription('Application forms for staff, whitelist or anything else')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(s => s
    .setName('create')
    .setDescription('Create an application form (Manage Server)')
    .addStringOption(o => o.setName('name').setDescription('Form name, e.g. Staff').setRequired(true).setMaxLength(NAME_MAX))
    .addChannelOption(o => o.setName('review_channel').setDescription('Where submitted applications are posted for staff').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Text on the Apply panel (type \\n for a new line)').setMaxLength(1000))
    .addRoleOption(o => o.setName('accept_role').setDescription('Role given when an application is accepted'))
    .addRoleOption(o => o.setName('reviewer_role').setDescription('Role that can accept or deny (Manage Server always can)')))
  .addSubcommand(s => s
    .setName('edit')
    .setDescription("Change a form's settings (Manage Server)")
    .addStringOption(formOption)
    .addChannelOption(o => o.setName('review_channel').setDescription('New review channel').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('description').setDescription('New panel text (type \\n for a new line)').setMaxLength(1000))
    .addRoleOption(o => o.setName('accept_role').setDescription('New role given on accept'))
    .addRoleOption(o => o.setName('reviewer_role').setDescription('New reviewer role'))
    .addStringOption(o => o.setName('remove').setDescription('Clear a setting').addChoices(
      { name: 'Accept role', value: 'accept_role' }, { name: 'Reviewer role', value: 'reviewer_role' }, { name: 'Description', value: 'description' })))
  .addSubcommandGroup(g => g
    .setName('question')
    .setDescription('The questions on a form')
    .addSubcommand(s => s
      .setName('add')
      .setDescription('Add a question (Manage Server)')
      .addStringOption(formOption)
      .addStringOption(o => o.setName('text').setDescription('The question, max 45 characters (Discord shows it as a form label)').setRequired(true).setMaxLength(LABEL_MAX))
      .addStringOption(o => o.setName('style').setDescription('Size of the answer box').setRequired(true).addChoices(
        { name: 'Short (one line)', value: 'short' }, { name: 'Paragraph', value: 'paragraph' }))
      .addBooleanOption(o => o.setName('required').setDescription('Must be answered (default: yes)'))
      .addIntegerOption(o => o.setName('position').setDescription('Insert as this number instead of at the end').setMinValue(1).setMaxValue(MAX_QUESTIONS)))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription('Remove a question by its number (Manage Server)')
      .addStringOption(formOption)
      .addIntegerOption(o => o.setName('number').setDescription('Question number, see /application question list').setRequired(true).setMinValue(1).setMaxValue(MAX_QUESTIONS)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription("Show a form's questions and settings (Manage Server)")
      .addStringOption(formOption)))
  .addSubcommand(s => s
    .setName('panel')
    .setDescription('Post the Apply button for a form (Manage Server)')
    .addStringOption(formOption)
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it').addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand(s => s
    .setName('delete')
    .setDescription('Delete a form and its pending applications (Manage Server)')
    .addStringOption(formOption))
  .addSubcommand(s => s
    .setName('status')
    .setDescription('Check on your applications')
    .addStringOption(o => o.setName('form').setDescription('Only this form').setMaxLength(NAME_MAX)));

// Unfinished applications live only in memory: a restart drops them instead of posting a half-filled form.
const drafts = new Map();
const submitting = new Set();
const deciding = new Set();
let draftSeq = 0;

const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const when = ms => `<t:${Math.floor(ms / 1000)}:R>`;
const panelText = raw => raw?.replace(/\\n/g, '\n').trim() || null;
const pageCount = draft => Math.ceil(draft.questions.length / PER_PAGE);
const draftKey = (guildId, formId, userId) => `${guildId}:${formId}:${userId}`;
const ttl = ctx => ctx.applicationDraftTtlMs ?? DRAFT_TTL;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function section(ctx, guildId) {
  const g = ctx.store.guild(guildId);
  if (!g.applications || typeof g.applications !== 'object') g.applications = {};
  const s = g.applications;
  s.forms ??= {};
  s.apps ??= {};
  s.posting ??= {};
  s.nextFormId ??= 1;
  s.nextAppId ??= 1;
  return s;
}

const button = (id, label, emoji, style) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  return emoji ? b.setEmoji(emoji) : b;
};
const row = (...buttons) => new ActionRowBuilder().addComponents(buttons);
const resumeRow = (draft, label) => row(button(`application:resume:${draft.formId}`, label, null, ButtonStyle.Primary));

function findForm(s, name) {
  const key = clean(name).toLowerCase();
  return Object.values(s.forms).find(f => f.name.toLowerCase() === key) || null;
}

// Replies with the server's form names when the one typed doesn't exist.
async function formOrExplain(interaction, s) {
  const name = interaction.options.getString('form', true);
  const form = findForm(s, name);
  if (form) return form;
  const names = Object.values(s.forms).map(f => `**${f.name}**`);
  await ephemeral(interaction, names.length
    ? `There's no form called **${clean(name)}**. Forms on this server: ${names.join(', ')}.`
    : 'This server has no application forms yet. Create one with `/application create`.');
  return null;
}

function formSummary(form) {
  const reviewers = form.reviewerRoleId ? `<@&${form.reviewerRoleId}> and anyone with **Manage Server**` : 'anyone with **Manage Server**';
  return [
    `Review channel: <#${form.reviewChannelId}>`,
    `Accepted applicants get: ${form.acceptRoleId ? `<@&${form.acceptRoleId}>` : 'no role'}`,
    `Reviewers: ${reviewers}`,
    `Questions: ${form.questions.length}`,
  ].join('\n');
}

function settingsProblem(interaction, me, { channel, acceptRole, reviewerRole }) {
  if (reviewerRole?.id === interaction.guildId) return 'Pick an actual reviewer role, not @everyone, or every member could accept applications.';
  if (acceptRole) {
    const problem = grantProblem(interaction, acceptRole) || roleProblem(acceptRole, me);
    if (problem) return problem;
  }
  return channel ? cantPost(channel, me, { files: true, history: true }) : null;
}

// Applications hold personal answers, so say so when the whole server can read them.
const publicWarning = channel => (channel.permissionsFor(channel.guild.roles.everyone)?.has(P.ViewChannel)
  ? `\n⚠️ Everyone can see ${channel}, so applications posted there are public. Hide it from @everyone if they should stay private.`
  : '');

const panelEmbed = (form, color) => new EmbedBuilder().setColor(color).setTitle(clip(form.name, 256))
  .setDescription(form.description || `Press **Apply** to fill in the ${form.name} application. Your answers go privately to the staff team.`);

async function refreshPanels(guild, form, color) {
  await Promise.allSettled((form.panels || []).map(async p => {
    const message = await guild.channels.cache.get(p.channelId)?.messages.fetch(p.messageId);
    await message?.edit({ embeds: [panelEmbed(form, color)] });
  }));
}

// ---------- admin ----------

async function create(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const name = clean(interaction.options.getString('name', true));
  const channel = interaction.options.getChannel('review_channel', true);
  const acceptRole = interaction.options.getRole('accept_role');
  const reviewerRole = interaction.options.getRole('reviewer_role');
  if (!name) return ephemeral(interaction, 'Give the form a name.');
  if (name.length > NAME_MAX) return ephemeral(interaction, `Form names can be up to ${NAME_MAX} characters.`);
  const problem = settingsProblem(interaction, await botMember(interaction.guild), { channel, acceptRole, reviewerRole });
  if (problem) return ephemeral(interaction, problem);

  const s = section(ctx, interaction.guildId);
  const taken = findForm(s, name);
  if (taken) return ephemeral(interaction, `There's already a form called **${taken.name}**. Pick another name, or change that one with \`/application edit\`.`);
  if (Object.keys(s.forms).length >= MAX_FORMS) return ephemeral(interaction, `This server already has ${MAX_FORMS} forms, the most it can have. Delete one first.`);
  const id = String(s.nextFormId++);
  const form = {
    id, name, description: panelText(interaction.options.getString('description')), reviewChannelId: channel.id,
    acceptRoleId: acceptRole?.id ?? null, reviewerRoleId: reviewerRole?.id ?? null, questions: [], panels: [],
  };
  s.forms[id] = form;
  ctx.store.save();
  return ephemeral(interaction, `Created **${name}**.\n${formSummary(form)}\nNext: add questions with \`/application question add\`, then post the Apply button with \`/application panel\`.${publicWarning(channel)}`);
}

const REMOVABLE = { accept_role: 'acceptRoleId', reviewer_role: 'reviewerRoleId', description: 'description' };

async function edit(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = section(ctx, interaction.guildId);
  const form = await formOrExplain(interaction, s);
  if (!form) return;
  const { options } = interaction;
  const channel = options.getChannel('review_channel');
  const acceptRole = options.getRole('accept_role');
  const reviewerRole = options.getRole('reviewer_role');
  const description = options.getString('description');
  const remove = options.getString('remove');
  if (!channel && !acceptRole && !reviewerRole && description == null && !remove) return ephemeral(interaction, 'Nothing to change: pick at least one option.');
  const setting = { accept_role: acceptRole, reviewer_role: reviewerRole, description };
  if (remove && setting[remove] != null) return ephemeral(interaction, "You can't set and remove the same setting at once.");
  // choosing who may accept is as powerful as choosing the role they hand out
  const handedOut = reviewerRole && !acceptRole && form.acceptRoleId ? interaction.guild.roles.cache.get(form.acceptRoleId) : null;
  const problem = (handedOut && grantProblem(interaction, handedOut))
    || settingsProblem(interaction, await botMember(interaction.guild), { channel, acceptRole, reviewerRole });
  if (problem) return ephemeral(interaction, problem);

  if (channel) form.reviewChannelId = channel.id;
  if (acceptRole) form.acceptRoleId = acceptRole.id;
  if (reviewerRole) form.reviewerRoleId = reviewerRole.id;
  if (description != null) form.description = panelText(description);
  if (remove) form[REMOVABLE[remove]] = null;
  ctx.store.save();
  if (description != null || remove === 'description') await refreshPanels(interaction.guild, form, ctx.color);
  return ephemeral(interaction, `Updated **${form.name}**.\n${formSummary(form)}${channel ? publicWarning(channel) : ''}`);
}

async function addQuestion(interaction, ctx) {
  const s = section(ctx, interaction.guildId);
  const form = await formOrExplain(interaction, s);
  if (!form) return;
  const text = clean(interaction.options.getString('text', true));
  const style = interaction.options.getString('style', true) === 'paragraph' ? 'paragraph' : 'short';
  const required = interaction.options.getBoolean('required') ?? true;
  const position = interaction.options.getInteger('position');
  if (!text) return ephemeral(interaction, 'The question needs some text.');
  if (text.length > LABEL_MAX) {
    return ephemeral(interaction, `Questions can be up to ${LABEL_MAX} characters, because Discord shows them as form labels. Put longer instructions in the form description.`);
  }
  if (form.questions.length >= MAX_QUESTIONS) return ephemeral(interaction, `**${form.name}** already has ${MAX_QUESTIONS} questions, the most a form can have.`);
  const index = Math.min(position ?? Infinity, form.questions.length + 1) - 1;
  form.questions.splice(index, 0, { text, style, required });
  ctx.store.save();
  const pages = Math.ceil(form.questions.length / PER_PAGE);
  return ephemeral(interaction, `Added question ${index + 1} to **${form.name}** (${style === 'paragraph' ? 'paragraph' : 'short answer'}, ${required ? 'required' : 'optional'}): ${text}\n`
    + `The form now has ${plural(form.questions.length, 'question')}${pages > 1 ? `, answered over ${pages} pages of ${PER_PAGE}` : ''}.`);
}

async function removeQuestion(interaction, ctx) {
  const s = section(ctx, interaction.guildId);
  const form = await formOrExplain(interaction, s);
  if (!form) return;
  const number = interaction.options.getInteger('number', true);
  const count = form.questions.length;
  if (!count) return ephemeral(interaction, `**${form.name}** has no questions.`);
  if (number < 1 || number > count) return ephemeral(interaction, `**${form.name}** has questions 1 to ${count}. See them with \`/application question list\`.`);
  const [removed] = form.questions.splice(number - 1, 1);
  ctx.store.save();
  return ephemeral(interaction, `Removed question ${number} from **${form.name}**: ${removed.text}${number < count ? '\nThe questions after it moved up one number.' : ''}`);
}

async function listQuestions(interaction, ctx) {
  const s = section(ctx, interaction.guildId);
  const form = await formOrExplain(interaction, s);
  if (!form) return;
  const lines = form.questions.map((q, i) => `**${i + 1}.** ${q.text} · ${q.style}${q.required ? '' : ' · optional'}`);
  const embed = new EmbedBuilder().setColor(ctx.color).setTitle(clip(form.name, 256))
    .setDescription(clip(`${formSummary(form)}\n\n${lines.join('\n') || 'No questions yet. Add some with `/application question add`.'}`, 4096))
    .setFooter({ text: `Applicants answer ${PER_PAGE} questions per page.` });
  return ephemeral(interaction, null, { embeds: [embed] });
}

async function panel(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = section(ctx, interaction.guildId);
  const form = await formOrExplain(interaction, s);
  if (!form) return;
  const channel = interaction.options.getChannel('channel', true);
  const problem = cantPost(channel, await botMember(interaction.guild));
  if (problem) return ephemeral(interaction, problem);
  const message = await channel.send({
    embeds: [panelEmbed(form, ctx.color)],
    components: [row(button(`application:apply:${form.id}`, 'Apply', '📝', ButtonStyle.Primary))],
  });
  form.panels = [...(form.panels || []), { channelId: channel.id, messageId: message.id }].slice(-MAX_PANELS);
  ctx.store.save();
  const notes = [`Apply button for **${form.name}** posted in ${channel}.`];
  if (!form.questions.length) notes.push(`⚠️ **${form.name}** has no questions yet, so the button will just say that. Add some with \`/application question add\`.`);
  if (!interaction.guild.channels.cache.has(form.reviewChannelId)) notes.push('⚠️ The review channel was deleted. Set a new one with `/application edit` or nobody can apply.');
  return ephemeral(interaction, notes.join('\n'));
}

async function requestDelete(interaction, ctx) {
  const s = section(ctx, interaction.guildId);
  const form = await formOrExplain(interaction, s);
  if (!form) return;
  const pending = Object.values(s.apps).filter(a => a.formId === form.id && a.status === 'pending').length;
  return ephemeral(interaction, `Delete **${form.name}** with its ${plural(form.questions.length, 'question')}${pending ? ` and ${plural(pending, 'pending application')}` : ''}? This can't be undone.`, {
    components: [row(button(`application:delete:${form.id}`, 'Yes, delete it', '🗑️', ButtonStyle.Danger))],
  });
}

async function confirmDelete(interaction, ctx, [formId]) {
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to delete forms.');
  const s = section(ctx, interaction.guildId);
  const form = s.forms[formId];
  if (!form) return interaction.update({ content: 'That form was already deleted.', components: [] });
  delete s.forms[formId];
  for (const app of Object.values(s.apps)) if (app.formId === formId) delete s.apps[app.id];
  for (const key of drafts.keys()) if (key.startsWith(`${interaction.guildId}:${formId}:`)) drafts.delete(key);
  ctx.store.save();
  await interaction.update({ content: `Deleted **${form.name}**.`, components: [] });
  await Promise.allSettled((form.panels || []).map(p => interaction.guild.channels.cache.get(p.channelId)?.messages.delete(p.messageId)));
}

// ---------- applying ----------

function getDraft(key) {
  const draft = drafts.get(key);
  if (draft && draft.expiresAt <= Date.now()) {
    drafts.delete(key);
    return null;
  }
  return draft || null;
}

function sweepDrafts() {
  const now = Date.now();
  for (const [key, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(key);
}

function pageModal(draft) {
  const pages = pageCount(draft);
  const start = draft.page * PER_PAGE;
  const title = pages > 1 ? `${clip(draft.formName, 38)} (${draft.page + 1}/${pages})` : clip(draft.formName, 45);
  const labels = draft.questions.slice(start, start + PER_PAGE).map((q, n) => {
    const index = start + n;
    const input = new TextInputBuilder().setCustomId(`q${index}`).setRequired(q.required)
      .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setMaxLength(ANSWER_MAX[q.style] ?? ANSWER_MAX.short);
    if (draft.answers[index]) input.setValue(draft.answers[index]);
    const label = new LabelBuilder().setLabel(clip(q.text, LABEL_MAX)).setTextInputComponent(input);
    return pages > 1 ? label.setDescription(`Question ${index + 1} of ${draft.questions.length}`) : label;
  });
  return new ModalBuilder().setCustomId(`application:page:${draft.formId}:${draft.id}:${draft.page}`).setTitle(title).addLabelComponents(labels);
}

function readField(interaction, id) {
  try {
    return interaction.fields.getTextInputValue(id) ?? '';
  } catch {
    return ''; // a stale modal may not carry this field; required questions then get asked again
  }
}

// Gone if its channel or message was deleted by hand; any other error counts as still there.
async function reviewPostExists(guild, app) {
  const channel = guild.channels.cache.get(app.channelId);
  if (!channel) return false;
  try {
    await channel.messages.fetch({ message: app.messageIds.at(-1), force: true }); // the cache never hears about deletes
    return true;
  } catch (err) {
    return err.code !== RESTJSONErrorCodes.UnknownMessage && err.code !== RESTJSONErrorCodes.UnknownChannel;
  }
}

async function pendingApp(guild, ctx, s, formId, userId) {
  const app = Object.values(s.apps).find(a => a.status === 'pending' && a.formId === formId && a.userId === userId);
  if (!app || await reviewPostExists(guild, app)) return app || null;
  // nobody can decide on a post that was deleted, so don't keep the applicant blocked by it
  if (s.apps[app.id] === app) delete s.apps[app.id];
  ctx.store.save();
  return null;
}

function reviewChannelProblem(guild, form, me) {
  const channel = guild.channels.cache.get(form.reviewChannelId);
  if (!channel?.isTextBased()) return 'the review channel was deleted.';
  return cantPost(channel, me);
}

const resumeDraft = (interaction, ctx, draft) =>
  (draft.page < pageCount(draft) ? interaction.showModal(pageModal(draft)) : finish(interaction, ctx, draft));

async function apply(interaction, ctx, [formId]) {
  const s = section(ctx, interaction.guildId);
  const form = s.forms[formId];
  if (!form) return ephemeral(interaction, 'This application form no longer exists.');
  const { guild, user } = interaction;
  const key = draftKey(guild.id, formId, user.id);
  const draft = getDraft(key);
  if (draft) return resumeDraft(interaction, ctx, draft);
  if (!form.questions.length) return ephemeral(interaction, `**${form.name}** has no questions yet, so there's nothing to fill in. Please let a server admin know.`);
  if (form.acceptRoleId && interaction.member.roles.cache.has(form.acceptRoleId)) {
    return ephemeral(interaction, `You already have <@&${form.acceptRoleId}>, so there's no need to apply.`);
  }
  const pending = await pendingApp(guild, ctx, s, formId, user.id);
  if (pending) return ephemeral(interaction, `You already applied for **${form.name}** ${when(pending.submittedAt)}. You'll get a DM when staff decide, or check with \`/application status\`.`);
  const closed = reviewChannelProblem(guild, form, await botMember(guild));
  if (closed) return ephemeral(interaction, `Applications for **${form.name}** can't be sent right now: ${closed} Please let a server admin know.`);

  const raced = getDraft(key); // a double click started one while we were checking
  if (raced) return resumeDraft(interaction, ctx, raced);
  sweepDrafts();
  const fresh = {
    id: (++draftSeq).toString(36), guildId: guild.id, formId, userId: user.id, formName: form.name,
    questions: form.questions.map(q => ({ ...q })), // later edits to the form don't shift answers mid-application
    answers: [], page: 0, expiresAt: Date.now() + ttl(ctx),
  };
  drafts.set(key, fresh);
  return interaction.showModal(pageModal(fresh));
}

async function resume(interaction, ctx, [formId]) {
  const draft = getDraft(draftKey(interaction.guildId, formId, interaction.user.id));
  if (draft) return resumeDraft(interaction, ctx, draft);
  const s = section(ctx, interaction.guildId);
  const sent = Object.values(s.apps).some(a => a.formId === formId && a.userId === interaction.user.id && a.status === 'pending');
  return ephemeral(interaction, sent ? 'Your application was already sent. Check on it with `/application status`.' : EXPIRED);
}

async function savePage(interaction, ctx, [formId, draftId, pageText]) {
  const draft = getDraft(draftKey(interaction.guildId, formId, interaction.user.id));
  if (!draft || draft.id !== draftId) return ephemeral(interaction, EXPIRED);
  const pages = pageCount(draft);
  if (Number(pageText) !== draft.page) {
    return ephemeral(interaction, 'That page was already saved.', { components: [resumeRow(draft, draft.page < pages ? 'Continue' : 'Send application')] });
  }
  const start = draft.page * PER_PAGE;
  const questions = draft.questions.slice(start, start + PER_PAGE);
  questions.forEach((q, n) => {
    draft.answers[start + n] = readField(interaction, `q${start + n}`).trim().slice(0, ANSWER_MAX[q.style] ?? ANSWER_MAX.short);
  });
  draft.expiresAt = Date.now() + ttl(ctx);
  const blank = questions.findIndex((q, n) => q.required && !draft.answers[start + n]);
  if (blank !== -1) {
    return ephemeral(interaction, `Question ${start + blank + 1} needs an answer.`, { components: [resumeRow(draft, `Answer page ${draft.page + 1} again`)] });
  }
  draft.page++;
  if (draft.page < pages) {
    return ephemeral(interaction, `Page ${draft.page} of ${pages} saved. Your answers are kept for 30 minutes.`, {
      components: [resumeRow(draft, `Continue (page ${draft.page + 1}/${pages})`)],
    });
  }
  return finish(interaction, ctx, draft);
}

async function finish(interaction, ctx, draft) {
  const key = draftKey(draft.guildId, draft.formId, draft.userId);
  if (submitting.has(key)) return ephemeral(interaction, 'Hang on, your application is already being sent.');
  submitting.add(key);
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const s = section(ctx, interaction.guildId);
    const form = s.forms[draft.formId];
    if (!form) {
      drafts.delete(key);
      return ephemeral(interaction, 'This form was deleted while you were filling it in, so there is nowhere to send your application.');
    }
    if (await pendingApp(interaction.guild, ctx, s, form.id, draft.userId)) {
      drafts.delete(key);
      return ephemeral(interaction, `You already have a pending **${form.name}** application.`);
    }
    const problem = await postReview(interaction, ctx, s, form, draft);
    if (problem) {
      return ephemeral(interaction, `I couldn't send your application: ${problem} Your answers are kept for 30 minutes, so let a server admin know, then press **Try again**.`, {
        components: [resumeRow(draft, 'Try again')],
      });
    }
    drafts.delete(key);
    return ephemeral(interaction, `Your **${form.name}** application was sent to the staff team. You'll get a DM when they decide (keep DMs from this server open), or check with \`/application status\`.`, { components: [] });
  } finally {
    submitting.delete(key);
  }
}

// ---------- the review post ----------

const embedChars = e => (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.author?.name?.length ?? 0)
  + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

// Splits at a line break or space near the limit when there is one, never inside an emoji.
function chunkText(text, max) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    const atSpace = cut >= max / 2;
    if (!atSpace) cut = /[\uD800-\uDBFF]/.test(rest[max - 1]) ? max - 1 : max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(atSpace ? cut + 1 : cut);
  }
  parts.push(rest);
  return parts;
}

function answerFields({ questions, answers }) {
  return questions.flatMap((q, i) => chunkText(answers[i] || '*No answer*', 1024).map((value, n) => ({
    name: clip(`${i + 1}. ${q.text}${n ? ' (continued)' : ''}`, 256),
    value: value.trim() ? value : '\u200b', // Discord rejects blank field values
  })));
}

// Groups fields into embeds (25 fields each) and messages (10 embeds, 6000 characters each).
function pack(fields, headerChars) {
  const messages = [];
  let embeds = [];
  let current = null;
  let size = headerChars;
  let room = 9; // the first message also carries the header embed
  for (const field of fields) {
    const len = field.name.length + field.value.length;
    const embedFull = !current || current.length === 25;
    if (size + len > MESSAGE_CHARS || (embedFull && embeds.length === room)) {
      messages.push(embeds);
      embeds = [];
      current = null;
      size = 0;
      room = 10;
    }
    if (!current || current.length === 25) {
      current = [];
      embeds.push(current);
    }
    current.push(field);
    size += len;
  }
  messages.push(embeds);
  return messages;
}

function applicationText(form, id, user, { questions, answers }) {
  const lines = [
    `${form.name} application #${id}`,
    `Applicant: ${user.tag} (${user.id})`,
    `Submitted: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
  ];
  questions.forEach((q, i) => lines.push('', `${i + 1}. ${q.text}`, answers[i] || '(no answer)'));
  return `${lines.join('\n')}\n`;
}

function reviewPayloads({ form, id, user, member, draft, color, canAttach }) {
  const facts = [{ name: 'Applicant', value: `${user} · ${user.tag}`, inline: true }];
  if (user.createdTimestamp) facts.push({ name: 'Account created', value: when(user.createdTimestamp), inline: true });
  if (member?.joinedTimestamp) facts.push({ name: 'Joined server', value: when(member.joinedTimestamp), inline: true });
  const header = new EmbedBuilder().setColor(color).setTitle(clip(`${form.name} application`, 256))
    .setAuthor({ name: clip(user.tag, 256), iconURL: user.displayAvatarURL() })
    .addFields(facts).setFooter({ text: `Application #${id}` }).setTimestamp();
  const intro = `📨 New **${form.name}** application from ${user}`;
  const decide = row(
    button(`application:accept:${id}`, 'Accept', '✅', ButtonStyle.Success),
    button(`application:deny:${id}`, 'Deny', '✖️', ButtonStyle.Danger));

  const messages = pack(answerFields(draft), embedChars(header.toJSON()));
  if (messages.length > MAX_REVIEW_MESSAGES && canAttach) {
    header.setDescription(`This application is too long to show here, so all ${draft.questions.length} answers are in the attached file.`);
    const file = new AttachmentBuilder(Buffer.from(applicationText(form, id, user, draft), 'utf8'), { name: `application-${id}.txt` });
    return [{ content: intro, embeds: [header], files: [file], components: [decide], allowedMentions: { parse: [] } }];
  }
  return messages.map((groups, n) => ({
    content: n ? `Application #${id}, part ${n + 1} of ${messages.length}` : intro,
    embeds: [...(n ? [] : [header]), ...groups.map(fields => new EmbedBuilder().setColor(color).addFields(fields))],
    components: n === messages.length - 1 ? [decide] : [],
    allowedMentions: { parse: [] },
  }));
}

// Returns why posting failed, or null once the application is posted and recorded.
async function postReview(interaction, ctx, s, form, draft) {
  const { guild, user } = interaction;
  const me = await botMember(guild);
  const closed = reviewChannelProblem(guild, form, me);
  if (closed) return closed;
  const channel = guild.channels.cache.get(form.reviewChannelId);
  const id = s.nextAppId++;
  const payloads = reviewPayloads({ form, id, user, member: interaction.member, draft, color: ctx.color, canAttach: !cantPost(channel, me, { files: true }) });
  // Tracked while posting so that onReady can remove a post a restart cut short.
  const posting = { channelId: channel.id, messageIds: [] };
  s.posting[id] = posting;
  ctx.store.save();
  try {
    for (const payload of payloads) {
      posting.messageIds.push((await channel.send(payload)).id);
      ctx.store.save();
    }
  } catch (err) {
    console.error('Posting an application failed:', err.message);
    await Promise.allSettled(posting.messageIds.map(mid => channel.messages.delete(mid)));
    delete s.posting[id];
    ctx.store.save();
    return 'posting in the review channel failed.';
  }
  delete s.posting[id];
  s.apps[id] = { id, formId: form.id, userId: user.id, status: 'pending', channelId: channel.id, messageIds: posting.messageIds, submittedAt: Date.now() };
  ctx.store.save();
  return null;
}

// ---------- reviewing ----------

const holdsReviewerRole = (interaction, form) => Boolean(form.reviewerRoleId && interaction.member.roles.cache.has(form.reviewerRoleId));

function reviewProblem(interaction, s, app) {
  const form = app && s.forms[app.formId];
  if (!form) return 'This application is no longer open for review. Its form may have been deleted.';
  if (!isAdmin(interaction) && !holdsReviewerRole(interaction, form)) {
    return `Only ${form.reviewerRoleId ? `<@&${form.reviewerRoleId}> and people with` : 'people with'} **Manage Server** can review applications.`;
  }
  if (app.status !== 'pending') return `This application was already ${app.status} by <@${app.decidedBy}> ${when(app.decidedAt)}.`;
  if (app.userId === interaction.user.id) return "You can't review your own application.";
  if (deciding.has(`${interaction.guildId}:${app.id}`)) return 'Another reviewer is deciding on this application right now.';
  return null;
}

function refuse(interaction, app, problem) {
  // a decision whose message edit failed can leave live-looking buttons behind; clear them on the next click
  if (!app || app.status !== 'pending') interaction.message?.edit({ components: [] }).catch(() => {});
  return ephemeral(interaction, problem);
}

async function fetchMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch (err) {
    if (err.code === RESTJSONErrorCodes.UnknownMember) return null;
    throw err;
  }
}

function prune(s) {
  const decided = Object.values(s.apps).filter(a => a.status !== 'pending').sort((a, b) => a.decidedAt - b.decidedAt);
  for (const app of decided.slice(0, Math.max(0, decided.length - KEEP_DECIDED))) delete s.apps[app.id];
}

async function markReviewPost(interaction, app, content) {
  const channel = interaction.guild.channels.cache.get(app.channelId);
  if (!channel) return;
  for (const id of new Set([app.messageIds[0], app.messageIds.at(-1)])) {
    try {
      const message = interaction.message?.id === id ? interaction.message : await channel.messages.fetch(id);
      await message.edit({ content, components: [], allowedMentions: { parse: [] } });
    } catch (err) {
      if (err.code !== RESTJSONErrorCodes.UnknownMessage) console.error('Updating an application post failed:', err.message);
    }
  }
}

function resultDm(guild, form, app, roleName) {
  if (app.status === 'accepted') {
    return `🎉 Your **${form.name}** application in **${guild.name}** was accepted!${roleName ? ` You now have the **${roleName}** role.` : ''}`;
  }
  return `Your **${form.name}** application in **${guild.name}** was denied.${app.reason ? `\n**Reason:** ${app.reason}` : ''}`;
}

// Records the decision first, so it sticks even if the DM or the message edit fails.
async function settle(interaction, ctx, s, app, form, { status, reason = null, note = '', roleName = null }) {
  Object.assign(app, { status, reason, decidedBy: interaction.user.id, decidedAt: Date.now() });
  prune(s);
  ctx.store.save();
  const dmed = await interaction.client.users
    .send(app.userId, { content: resultDm(interaction.guild, form, app, roleName), allowedMentions: { parse: [] } })
    .then(() => true, () => false);
  const head = status === 'accepted' ? '✅ **Accepted**' : '❌ **Denied**';
  const dmNote = dmed ? '' : " · couldn't DM them";
  await markReviewPost(interaction, app, `${head} by ${interaction.user} ${when(app.decidedAt)}${note}${dmNote}${reason ? `\n**Reason:** ${reason}` : ''}`);
  return dmed ? 'They got a DM with the result.' : "Their DMs are closed, so I couldn't tell them. They can see the result with `/application status`.";
}

async function withDecisionLock(interaction, ctx, appId, work) {
  const s = section(ctx, interaction.guildId);
  const app = s.apps[appId];
  const problem = reviewProblem(interaction, s, app);
  if (problem) return refuse(interaction, app, problem);
  const lock = `${interaction.guildId}:${app.id}`;
  deciding.add(lock);
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return await work(s, app, s.forms[app.formId]);
  } finally {
    deciding.delete(lock);
  }
}

async function accept(interaction, ctx, [appId]) {
  return withDecisionLock(interaction, ctx, appId, async (s, app, form) => {
    let note = '';
    let roleName = null;
    if (form.acceptRoleId) {
      const role = interaction.guild.roles.cache.get(form.acceptRoleId) ?? null;
      const problem = roleProblem(role, await botMember(interaction.guild));
      if (problem) {
        const fix = role ? '' : ' An admin can set a new accept role (or remove it) with `/application edit`.';
        return ephemeral(interaction, `I can't accept this yet: ${problem}${fix} Then press **Accept** again.`);
      }
      // Manage Server alone must not hand out a role its holder couldn't give directly, e.g. to their own alt
      const grant = !holdsReviewerRole(interaction, form) && grantProblem(interaction, role);
      if (grant) {
        const who = form.reviewerRoleId ? `someone with <@&${form.reviewerRoleId}> or who can give ${role} themselves` : `someone who can give ${role} themselves`;
        return ephemeral(interaction, `You can't accept this one: ${grant} Ask ${who}.`);
      }
      const member = await fetchMember(interaction.guild, app.userId);
      if (member) {
        try {
          if (!member.roles.cache.has(role.id)) await member.roles.add(role, `Application #${app.id} accepted by ${interaction.user.tag}`);
        } catch (err) {
          console.error('Giving the accept role failed:', err.message);
          return ephemeral(interaction, `I couldn't give <@${app.userId}> ${role}, so nothing was changed. Check that my role is above it, then press **Accept** again.`);
        }
        note = ` · gave them ${role}`;
        roleName = role.name;
      } else {
        note = ` · they left the server, so they didn't get ${role}`;
      }
    }
    const dm = await settle(interaction, ctx, s, app, form, { status: 'accepted', note, roleName });
    return ephemeral(interaction, `Accepted <@${app.userId}>'s **${form.name}** application${note.replace(' · ', '; ')}. ${dm}`);
  });
}

async function askDenyReason(interaction, ctx, [appId]) {
  const s = section(ctx, interaction.guildId);
  const app = s.apps[appId];
  const problem = reviewProblem(interaction, s, app);
  if (problem) return refuse(interaction, app, problem);
  return interaction.showModal(new ModalBuilder().setCustomId(`application:deny:${app.id}`).setTitle('Deny application')
    .addLabelComponents(new LabelBuilder()
      .setLabel('Reason (optional, sent to the applicant)')
      .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(REASON_MAX))));
}

async function deny(interaction, ctx, [appId]) {
  return withDecisionLock(interaction, ctx, appId, async (s, app, form) => {
    const reason = readField(interaction, 'reason').trim().slice(0, REASON_MAX) || null;
    const dm = await settle(interaction, ctx, s, app, form, { status: 'denied', reason });
    return ephemeral(interaction, `Denied <@${app.userId}>'s **${form.name}** application. ${dm}`);
  });
}

// ---------- status ----------

async function statusLine(interaction, ctx, s, form) {
  const { guild, user } = interaction;
  const draft = getDraft(draftKey(guild.id, form.id, user.id));
  if (draft) {
    const pages = pageCount(draft);
    return `📝 **${form.name}**: not sent yet (${Math.min(draft.page, pages)} of ${pages} pages answered). Press **Apply** to continue; it expires ${when(draft.expiresAt)}.`;
  }
  const pending = await pendingApp(guild, ctx, s, form.id, user.id);
  if (pending) return `⏳ **${form.name}**: sent ${when(pending.submittedAt)}, waiting for staff to review it.`;
  const last = Object.values(s.apps)
    .filter(a => a.formId === form.id && a.userId === user.id && a.status !== 'pending')
    .sort((a, b) => b.decidedAt - a.decidedAt)[0];
  if (!last) return null;
  if (last.status === 'accepted') return `✅ **${form.name}**: accepted ${when(last.decidedAt)}.`;
  return `❌ **${form.name}**: denied ${when(last.decidedAt)}.${last.reason ? `\n**Reason:** ${clip(last.reason, 300)}` : ''}`;
}

async function status(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = section(ctx, interaction.guildId);
  let forms = Object.values(s.forms);
  const only = interaction.options.getString('form');
  if (only) {
    const form = await formOrExplain(interaction, s);
    if (!form) return;
    forms = [form];
  }
  const lines = [];
  for (const form of forms) {
    const line = await statusLine(interaction, ctx, s, form);
    if (line) lines.push(line);
  }
  if (!lines.length) return ephemeral(interaction, only ? `You haven't applied for **${forms[0].name}**.` : "You haven't applied for anything on this server.");
  return ephemeral(interaction, null, {
    embeds: [new EmbedBuilder().setColor(ctx.color).setTitle('Your applications').setDescription(clip(lines.join('\n\n'), 4096))],
  });
}

// ---------- wiring ----------

async function execute(interaction, ctx) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  if (!group && sub === 'status') return status(interaction, ctx);
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to manage application forms.');
  if (group === 'question') {
    switch (sub) {
      case 'add': return addQuestion(interaction, ctx);
      case 'remove': return removeQuestion(interaction, ctx);
      case 'list': return listQuestions(interaction, ctx);
    }
    return;
  }
  switch (sub) {
    case 'create': return create(interaction, ctx);
    case 'edit': return edit(interaction, ctx);
    case 'panel': return panel(interaction, ctx);
    case 'delete': return requestDelete(interaction, ctx);
  }
}

// A restart in the middle of posting would leave part of an application with no buttons; take it down.
async function onReady(client, ctx) {
  let changed = false;
  for (const [guildId, g] of Object.entries(ctx.store.data.guilds)) {
    const posting = g?.applications?.posting;
    if (!posting || typeof posting !== 'object') continue;
    for (const [id, p] of Object.entries(posting)) {
      const channel = client.guilds.cache.get(guildId)?.channels.cache.get(p.channelId);
      if (channel) await Promise.allSettled((p.messageIds || []).map(mid => channel.messages.delete(mid)));
      delete posting[id];
      changed = true;
    }
  }
  if (changed) ctx.store.save();
}

module.exports = {
  data,
  execute,
  onReady,
  buttons: { apply, resume, accept, deny: askDenyReason, delete: confirmDelete },
  modals: { page: savePage, deny },
  chunkText,
  pack,
  reviewPayloads,
};
