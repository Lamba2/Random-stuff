const {
  SlashCommandBuilder, InteractionContextType, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, EmbedBuilder, MessageFlags, RESTJSONErrorCodes,
} = require('discord.js');
const { ephemeral, isAdmin, botMember, cantPost } = require('../lib/util');
const { createTicketChannel, closeButton, isStaff } = require('./ticket');
const { refreshPanel: refreshStockPanel } = require('./stock');

const MAX_PRODUCTS = 25; // one select menu holds 25 options
const MAX_OPEN_ORDERS = 3; // per buyer, so one person can't fill up the ticket category
const KEEP_ORDERS = 500;
const RECENT = 15;
const CREATE_TIMEOUT = 2 * 60 * 1000;
const HOLD_MS = 30 * 60 * 1000; // how long an unpaid order keeps its unit, so nobody can lock up stock by not paying
const ORDER_LIMIT = 5; // per buyer per ORDER_WINDOW, so closing and reordering can't spam staff with pings
const ORDER_WINDOW = 60 * 60 * 1000;
const CATALOG_BUDGET = 5500; // Discord allows 6000 characters per message across all embeds

const data = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('Sell products through order tickets')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(s => s
    .setName('add')
    .setDescription('Add a product, or update one with the same name (Manage Server)')
    .addStringOption(o => o.setName('name').setDescription('Product name').setRequired(true).setMaxLength(80))
    .addStringOption(o => o.setName('price').setDescription('Price to show, e.g. $5 or 500 Robux').setRequired(true).setMaxLength(40))
    .addStringOption(o => o.setName('description').setDescription('Short description, or "none" to remove it').setMaxLength(300))
    .addStringOption(o => o.setName('image_url').setDescription('Image link starting with https://, or "none" to remove it').setMaxLength(500))
    .addStringOption(o => o.setName('stock_item').setDescription('/stock item it sells from, or "none" to unlink it').setMaxLength(60)))
  .addSubcommand(s => s
    .setName('remove')
    .setDescription('Delete a product (Manage Server)')
    .addStringOption(o => o.setName('name').setDescription('Product name').setRequired(true).setMaxLength(80)))
  .addSubcommand(s => s.setName('list').setDescription("See what's for sale"))
  .addSubcommand(s => s
    .setName('payment')
    .setDescription('Payment instructions shown in every order ticket (Manage Server)')
    .addStringOption(o => o.setName('text').setDescription('e.g. PayPal Goods & Services to you@example.com, or "none"').setRequired(true).setMaxLength(1000)))
  .addSubcommand(s => s
    .setName('panel')
    .setDescription('Post the catalog members order from (Manage Server)')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it').addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand(s => s
    .setName('deliver')
    .setDescription('Mark an order delivered, e.g. one whose ticket was closed (Manage Server)')
    .addIntegerOption(o => o.setName('order').setDescription('Order number from /shop orders').setRequired(true).setMinValue(1)))
  .addSubcommand(s => s
    .setName('cancel')
    .setDescription('Cancel an order so it stops holding stock, e.g. after a refund (Manage Server)')
    .addIntegerOption(o => o.setName('order').setDescription('Order number from /shop orders').setRequired(true).setMinValue(1)))
  .addSubcommand(s => s
    .setName('orders')
    .setDescription('Recent orders (Manage Server)')
    .addUserOption(o => o.setName('buyer').setDescription('Only show orders from this member')));

const ordering = new Set();

const clean = text => (text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isNone = text => text.toLowerCase() === 'none';
const pad = n => String(n).padStart(4, '0');
const ago = ms => `<t:${Math.floor(ms / 1000)}:R>`;

// The link in the encoded form Discord accepts (no raw spaces), or null if it isn't a web link.
function webUrl(text) {
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function section(ctx, guildId) {
  const g = ctx.store.guild(guildId);
  if (!g.shop || typeof g.shop !== 'object') g.shop = {};
  const s = g.shop;
  s.products ??= {};
  s.orders ??= {};
  s.payment ??= null;
  s.panel ??= null;
  s.nextOrderId ??= 1;
  return s;
}

const sorted = s => Object.entries(s.products).sort(([, a], [, b]) => a.name.localeCompare(b.name));

function stockLabel(product, g) {
  if (!product.stockKey) return { icon: '🟢', text: 'Available' };
  const item = g.stock.items[product.stockKey];
  if (!item) return { icon: '⚫', text: 'Unavailable' };
  return item.quantity > 0 ? { icon: '🟢', text: `${item.quantity} in stock` } : { icon: '🔴', text: 'Sold out' };
}

function catalogEmbed(g, s, color) {
  const embed = new EmbedBuilder().setColor(color).setTitle('Shop');
  const products = sorted(s).map(([, p]) => p);
  if (!products.length) return embed.setDescription('Nothing for sale right now.');
  const intro = 'Pick a product from the menu below to open a private order ticket.';
  const rows = products.map(p => {
    const { icon, text } = stockLabel(p, g);
    return { p, name: clip(`${p.name} · ${p.price}`, 256), stock: `${icon} ${text}` };
  });
  // descriptions share whatever the names and stock lines leave of the message budget
  const fixed = 4 + intro.length + rows.reduce((n, r) => n + r.name.length + r.stock.length + 1, 0);
  const room = Math.floor((CATALOG_BUDGET - fixed) / rows.length);
  return embed.setDescription(intro).addFields(rows.map(r => ({
    name: r.name,
    value: r.p.description && room > 10 ? `${clip(r.p.description, room)}\n${r.stock}` : r.stock,
  })));
}

function panelPayload(guild, ctx) {
  const g = ctx.store.guild(guild.id);
  const s = section(ctx, guild.id);
  const products = sorted(s);
  if (!products.length) return { embeds: [catalogEmbed(g, s, ctx.color)], components: [] };
  // sold-out products stay in the menu so a restock through /stock works before the panel is redrawn
  const menu = new StringSelectMenuBuilder().setCustomId('shop:order').setPlaceholder('Choose a product to order')
    .addOptions(products.map(([key, p]) => ({
      label: clip(p.name, 100),
      value: key,
      description: clip(`${p.price} · ${stockLabel(p, g).text}`, 100),
    })));
  return { embeds: [catalogEmbed(g, s, ctx.color)], components: [new ActionRowBuilder().addComponents(menu)] };
}

async function refreshPanel(guild, ctx) {
  const s = section(ctx, guild.id);
  const panel = s.panel;
  if (!panel) return;
  // only forget the panel we failed on; /shop panel may have replaced it while we were waiting
  const forget = () => {
    if (s.panel?.messageId !== panel.messageId) return;
    s.panel = null;
    ctx.store.save();
  };
  const channel = guild.channels.cache.get(panel.channelId);
  if (!channel?.isTextBased()) return forget();
  try {
    const message = await channel.messages.fetch(panel.messageId);
    await message.edit(panelPayload(guild, ctx));
  } catch (err) {
    if (err.code === RESTJSONErrorCodes.UnknownMessage) forget();
    else console.error('Updating the shop panel failed:', err.message);
  }
}

// The order's ticket channel still exists, or is still being created.
function hasTicket(order, guild) {
  if (order.status === 'creating') return Date.now() - order.createdAt < CREATE_TIMEOUT;
  return guild.channels.cache.has(order.channelId);
}

const holdExpired = order => order.status === 'open' && Date.now() - order.createdAt >= HOLD_MS;

// A paid order keeps its unit until it is delivered or cancelled, even if its ticket was closed, or the item
// could be sold twice. An unpaid one only keeps it while its ticket is open and for HOLD_MS.
function holdsStock(order, guild) {
  if (order.status === 'paid') return true;
  return (order.status === 'open' || order.status === 'creating') && hasTicket(order, guild) && !holdExpired(order);
}

const reserved = (s, guild, stockKey) => Object.values(s.orders).filter(o => o.stockKey === stockKey && holdsStock(o, guild)).length;

function cantOrder(product, g, s, guild) {
  if (!product.stockKey) return null;
  const item = g.stock.items[product.stockKey];
  if (!item) return `Sorry, **${product.name}** isn't available right now.`;
  if (item.quantity <= 0) return `Sorry, **${product.name}** is sold out.`;
  if (reserved(s, guild, product.stockKey) >= item.quantity) {
    return `Sorry, every **${product.name}** left is reserved by an open order. Check back later in case one falls through.`;
  }
  return null;
}

// When this buyer may order again, or null if they're under the limit.
function nextOrderAt(s, userId) {
  const recent = Object.values(s.orders).map(o => (o.buyerId === userId ? o.createdAt : 0))
    .filter(t => Date.now() - t < ORDER_WINDOW).sort((a, b) => b - a);
  return recent.length >= ORDER_LIMIT ? recent[ORDER_LIMIT - 1] + ORDER_WINDOW : null;
}

function openOrderTickets(g, guild, userId) {
  const ids = [];
  for (const [id, t] of Object.entries(g.tickets.open)) {
    if (t.kind !== 'order' || t.ownerId !== userId) continue;
    if (guild.channels.cache.has(id)) ids.push(id);
    else delete g.tickets.open[id]; // someone deleted the channel by hand
  }
  return ids;
}

function prune(s, guild) {
  const ids = Object.keys(s.orders).sort((a, b) => a - b);
  let extra = ids.length - KEEP_ORDERS;
  for (const id of ids) {
    if (extra <= 0) break;
    if (hasTicket(s.orders[id], guild) || holdsStock(s.orders[id], guild)) continue;
    delete s.orders[id];
    extra--;
  }
}

function statusLine(order) {
  if (order.status === 'delivered') return `📦 Delivered by <@${order.deliveredBy}> ${ago(order.deliveredAt)}`;
  if (order.status === 'paid') return `💰 Paid, confirmed by <@${order.paidBy}> ${ago(order.paidAt)}`;
  if (order.status === 'cancelled') return `🚫 Cancelled by <@${order.cancelledBy}> ${ago(order.cancelledAt)}`;
  return '🕓 Waiting for payment';
}

function orderButtons(order) {
  const done = order.status === 'delivered' || order.status === 'cancelled';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`shop:paid:${order.id}`).setLabel('Mark paid').setEmoji('💰')
      .setStyle(ButtonStyle.Success).setDisabled(done || order.status === 'paid'),
    new ButtonBuilder().setCustomId(`shop:deliver:${order.id}`).setLabel('Delivered').setEmoji('📦')
      .setStyle(ButtonStyle.Primary).setDisabled(done),
    closeButton(),
  )];
}

function orderEmbed(order, product, payment, number, color) {
  const hold = order.stockKey ? `\nYour item is held for ${HOLD_MS / 60000} minutes. If you haven't paid by then, it may sell to someone else.` : '';
  const embed = new EmbedBuilder().setColor(color).setTitle(`Order #${order.id}`)
    .setDescription(`Pay using the instructions below, then post your proof of payment here. Staff will confirm it and deliver your order in this channel.${hold}`)
    .addFields(
      { name: 'Product', value: product.name, inline: true },
      { name: 'Price', value: product.price, inline: true },
      { name: 'Quantity', value: '1', inline: true },
      { name: 'Buyer', value: `<@${order.buyerId}>`, inline: true },
      { name: 'Status', value: statusLine(order), inline: true },
    )
    .setFooter({ text: `Ticket #${number}` });
  if (product.description) embed.addFields({ name: 'Details', value: product.description });
  embed.addFields({ name: 'How to pay', value: payment ? clip(payment, 1024) : 'A staff member will tell you how to pay.' });
  if (product.imageUrl) embed.setThumbnail(product.imageUrl);
  return embed;
}

// The order message with its Status field and buttons brought up to date.
function orderUpdate(interaction, order) {
  const shown = interaction.message?.embeds?.[0];
  if (!shown) return { components: orderButtons(order) };
  const embed = EmbedBuilder.from(shown);
  embed.setFields((embed.data.fields ?? []).map(f => (f.name === 'Status' ? { ...f, value: statusLine(order) } : f)));
  return { embeds: [embed], components: orderButtons(order) };
}

async function placeOrder(interaction, ctx) {
  const { guild, user } = interaction;
  const g = ctx.store.guild(guild.id);
  const s = section(ctx, guild.id);
  const key = interaction.values[0];
  const product = s.products[key];
  if (!product) return "That product isn't for sale anymore. I've updated the menu, so please pick again.";
  if (!g.tickets.config) return "Ordering isn't open yet: a server admin needs to run `/ticket setup` first.";
  const mine = openOrderTickets(g, guild, user.id);
  if (mine.length >= MAX_OPEN_ORDERS) {
    return `You already have ${mine.length} open orders: ${mine.map(id => `<#${id}>`).join(' ')}. Close one you're done with before ordering more.`;
  }
  const wait = nextOrderAt(s, user.id);
  if (wait) return `You've placed ${ORDER_LIMIT} orders in the last hour. You can order again ${ago(wait)}.`;
  const problem = cantOrder(product, g, s, guild);
  if (problem) return problem;

  // Recorded before the first await, so two buyers can't both get the last one in stock.
  const order = {
    id: s.nextOrderId++, productKey: key, product: product.name, price: product.price, stockKey: product.stockKey ?? null,
    buyerId: user.id, status: 'creating', channelId: null, createdAt: Date.now(),
  };
  s.orders[order.id] = order;
  prune(s, guild);
  ctx.store.save();

  const made = await createTicketChannel(guild, user, ctx, {
    name: () => `order-${pad(order.id)}-${user.username}`,
    topic: () => `Order #${order.id}: ${product.name} for ${user.tag} (${user.id})`,
    reason: `Order placed by ${user.tag}`,
    record: { kind: 'order', orderId: order.id },
  });
  if (made.error) {
    delete s.orders[order.id];
    ctx.store.save();
    return made.error;
  }
  const { channel, number, staffRole } = made;
  Object.assign(order, { status: 'open', channelId: channel.id });
  ctx.store.save();
  try {
    await channel.send({
      content: staffRole ? `${user} ${staffRole}` : `${user}`,
      embeds: [orderEmbed(order, product, s.payment, number, ctx.color)],
      components: orderButtons(order),
      allowedMentions: { users: [user.id], roles: staffRole ? [staffRole.id] : [] },
    });
  } catch (err) {
    // without its message the ticket has no buttons, so it could never be paid or delivered
    console.error('Posting the order message failed:', err.message);
    delete s.orders[order.id];
    ctx.store.save();
    await channel.delete('The order message could not be posted').then(() => {
      delete g.tickets.open[channel.id];
      ctx.store.save();
    }, () => {});
    return "I couldn't set up your order ticket, so I cancelled the order. Please let a server admin know.";
  }
  return `Your order ticket is open: ${channel}`;
}

async function order(interaction, ctx) {
  const lock = `${interaction.guildId}:${interaction.user.id}`;
  if (ordering.has(lock)) return ephemeral(interaction, 'Hang on, your order is already being set up.');
  ordering.add(lock);
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await placeOrder(interaction, ctx));
  } finally {
    ordering.delete(lock);
  }
  // also resets the menu, and picks up stock changed through /stock since the panel was last drawn
  await refreshPanel(interaction.guild, ctx);
}

function staffOrder(interaction, ctx, id, doing) {
  const g = ctx.store.guild(interaction.guildId);
  if (!isStaff(interaction.member, g.tickets.config)) return { error: `Only staff can ${doing}.` };
  const found = section(ctx, interaction.guildId).orders[id];
  if (!found) return { error: `I can't find order #${id} anymore.` };
  if (found.status === 'cancelled') return { error: `<@${found.cancelledBy}> cancelled order #${id}.` };
  return { g, order: found };
}

// More orders hold this stock item than it has units, e.g. one was paid after its hold ran out.
function oversold(interaction, ctx, o) {
  const item = o.stockKey && ctx.store.guild(interaction.guildId).stock.items[o.stockKey];
  if (!item || reserved(section(ctx, interaction.guildId), interaction.guild, o.stockKey) <= item.quantity) return null;
  return `⚠️ More orders are waiting for **${item.name}** than /stock has (${item.quantity}). Restock it, or cancel one with \`/shop cancel\`.`;
}

async function markPaid(interaction, ctx, [id]) {
  const { error, order: o } = staffOrder(interaction, ctx, id, 'mark orders as paid');
  if (error) return ephemeral(interaction, error);
  if (o.status === 'delivered') return ephemeral(interaction, `Order #${o.id} was already delivered.`);
  if (o.status === 'paid') return ephemeral(interaction, `<@${o.paidBy}> already marked order #${o.id} as paid.`);
  Object.assign(o, { status: 'paid', paidAt: Date.now(), paidBy: interaction.user.id });
  ctx.store.save();
  await interaction.update(orderUpdate(interaction, o));
  const warning = oversold(interaction, ctx, o);
  if (warning) await ephemeral(interaction, warning);
}

// Takes one off the linked /stock item and says what happened, for the staff member who delivered.
function takeStock(g, o) {
  if (!o.stockKey) return null;
  const item = g.stock.items[o.stockKey];
  if (!item) return `**${o.product}** sold from a /stock item that no longer exists, so no stock was taken off.`;
  if (item.quantity <= 0) return `**${item.name}** was already at 0 in /stock, so it stays at 0.`;
  item.quantity -= 1;
  return `**${item.name}** now has ${item.quantity} left in /stock.`;
}

function markDelivered(g, o, user, ctx) {
  Object.assign(o, { status: 'delivered', deliveredAt: Date.now(), deliveredBy: user.id });
  const stockNote = takeStock(g, o);
  ctx.store.save();
  return stockNote;
}

async function deliver(interaction, ctx, [id]) {
  const { error, g, order: o } = staffOrder(interaction, ctx, id, 'mark orders as delivered');
  if (error) return ephemeral(interaction, error);
  if (o.status === 'delivered') return ephemeral(interaction, `<@${o.deliveredBy}> already delivered order #${o.id}.`);
  const stockNote = markDelivered(g, o, interaction.user, ctx);
  await interaction.update(orderUpdate(interaction, o));

  const { user } = interaction;
  const content = user.id === o.buyerId
    ? `Order #${o.id} (**${o.product}**) is delivered.`
    : `<@${o.buyerId}> your order **${o.product}** was delivered by ${user}. Happy with it? Run \`/vouch give\` for ${user} to leave a review.`;
  await interaction.channel?.send({ content, allowedMentions: { users: [o.buyerId] } })
    .catch(err => console.error('Posting the delivery message failed:', err.message));
  if (stockNote) await ephemeral(interaction, stockNote);
  await refreshStockPanel(interaction.guild, ctx);
  await refreshPanel(interaction.guild, ctx);
}

// For orders the buttons can't reach anymore, e.g. a paid order whose ticket was closed.
async function settle(interaction, ctx, cancelling) {
  const id = interaction.options.getInteger('order', true);
  const g = ctx.store.guild(interaction.guildId);
  const o = section(ctx, interaction.guildId).orders[id];
  if (!o || (o.status === 'creating' && !hasTicket(o, interaction.guild))) return ephemeral(interaction, `There's no order #${id}. Check \`/shop orders\`.`);
  if (o.status === 'creating') return ephemeral(interaction, `Order #${id} is still being set up. Try again in a moment.`);
  if (o.status === 'delivered') return ephemeral(interaction, `<@${o.deliveredBy}> already delivered order #${id}.`);
  if (o.status === 'cancelled') return ephemeral(interaction, `<@${o.cancelledBy}> already cancelled order #${id}.`);
  let reply;
  if (cancelling) {
    Object.assign(o, { status: 'cancelled', cancelledAt: Date.now(), cancelledBy: interaction.user.id });
    ctx.store.save();
    reply = `Cancelled order #${id} (**${o.product}** for <@${o.buyerId}>). It no longer holds stock.`;
  } else {
    const stockNote = markDelivered(g, o, interaction.user, ctx);
    reply = `Marked order #${id} (**${o.product}** for <@${o.buyerId}>) as delivered.${stockNote ? ` ${stockNote}` : ''}`;
    await refreshStockPanel(interaction.guild, ctx);
  }
  await refreshPanel(interaction.guild, ctx);
  return ephemeral(interaction, reply);
}

// What still stands between this shop and its next order, for admins.
function setupNotes(g, s) {
  const notes = [];
  if (!g.tickets.config) notes.push("⚠️ Buyers can't order until a server admin runs `/ticket setup`.");
  if (!s.panel) notes.push('Post the catalog with `/shop panel` so members can order.');
  if (!s.payment) notes.push('Add payment instructions with `/shop payment` so every order ticket shows them.');
  const broken = Object.values(s.products).filter(p => p.stockKey && !g.stock.items[p.stockKey]).map(p => `**${p.name}**`);
  if (broken.length) {
    notes.push(clip(`⚠️ Linked to a /stock item that no longer exists, so they can't be ordered: ${broken.join(', ')}. Relink them with \`/shop add\`.`, 1200));
  }
  return notes;
}

async function add(interaction, ctx) {
  const name = clean(interaction.options.getString('name', true));
  const price = clean(interaction.options.getString('price', true));
  const description = clean(interaction.options.getString('description'));
  const imageUrl = clean(interaction.options.getString('image_url'));
  const stockName = clean(interaction.options.getString('stock_item'));
  if (!name || !price) return ephemeral(interaction, 'Give the product a name and a price, e.g. `$5` or `500 Robux`.');
  const key = name.toLowerCase();
  if (key.length > 100) return ephemeral(interaction, 'That name is too long for the order menu. Try a shorter one.');
  const g = ctx.store.guild(interaction.guildId);
  const s = section(ctx, interaction.guildId);
  const before = s.products[key];
  if (!before && Object.keys(s.products).length >= MAX_PRODUCTS) {
    return ephemeral(interaction, `The shop already has ${MAX_PRODUCTS} products, the most one menu can hold. Remove one with \`/shop remove\` first.`);
  }

  const product = { name, price, description: before?.description ?? null, imageUrl: before?.imageUrl ?? null, stockKey: before?.stockKey ?? null };
  if (description) product.description = isNone(description) ? null : description;
  if (imageUrl) {
    if (isNone(imageUrl)) product.imageUrl = null;
    else if (webUrl(imageUrl)) product.imageUrl = webUrl(imageUrl);
    else return ephemeral(interaction, 'The image link has to be a full web address starting with `https://` (or `http://`).');
  }
  if (stockName) {
    const stockKey = stockName.toLowerCase();
    if (isNone(stockName)) product.stockKey = null;
    else if (g.stock.items[stockKey]) product.stockKey = stockKey;
    else return ephemeral(interaction, `There's no /stock item called **${stockName}**. Add it with \`/stock set\` first, or check \`/stock view\` for the exact name.`);
  }
  s.products[key] = product;
  ctx.store.save();
  await refreshPanel(interaction.guild, ctx);

  const item = product.stockKey && g.stock.items[product.stockKey];
  const stock = item ? ` It sells from **${item.name}** in /stock (${item.quantity} left).` : '';
  const kept = before ? ' Options you left out kept their old value.' : '';
  const notes = setupNotes(g, s).map(n => `\n${n}`).join('');
  return ephemeral(interaction, clip(`${before ? 'Updated' : 'Added'} **${name}** at ${price}.${stock}${kept}${notes}`, 2000));
}

async function remove(interaction, ctx) {
  const name = clean(interaction.options.getString('name', true));
  const s = section(ctx, interaction.guildId);
  const key = name.toLowerCase();
  if (!s.products[key]) return ephemeral(interaction, `There's no product called **${name}**. Check \`/shop list\` for the exact name.`);
  const shown = s.products[key].name;
  delete s.products[key];
  ctx.store.save();
  await refreshPanel(interaction.guild, ctx);
  const open = Object.values(s.orders).filter(o => o.productKey === key && (o.status === 'paid' || (o.status === 'open' && hasTicket(o, interaction.guild)))).length;
  const note = open ? ` ${open} open order${open === 1 ? '' : 's'} for it can still be delivered.` : '';
  return ephemeral(interaction, `Removed **${shown}**.${note}`);
}

async function list(interaction, ctx) {
  const g = ctx.store.guild(interaction.guildId);
  const s = section(ctx, interaction.guildId);
  const notes = isAdmin(interaction) ? setupNotes(g, s) : [];
  return ephemeral(interaction, notes.length ? notes.join('\n') : null, { embeds: [catalogEmbed(g, s, ctx.color)] });
}

async function payment(interaction, ctx) {
  const text = interaction.options.getString('text', true).trim();
  if (!text) return ephemeral(interaction, 'Write the payment instructions, or `none` to remove them.');
  const s = section(ctx, interaction.guildId);
  s.payment = isNone(text) ? null : text;
  ctx.store.save();
  if (!s.payment) return ephemeral(interaction, 'Payment instructions removed. New order tickets will say a staff member will explain how to pay.');
  return ephemeral(interaction, `Saved. New order tickets will show:\n>>> ${text}`);
}

function orderLine(o, guild) {
  let status;
  if (o.status === 'delivered') status = `📦 delivered by <@${o.deliveredBy}>`;
  else if (o.status === 'cancelled') status = `🚫 cancelled by <@${o.cancelledBy}>`;
  else if (o.status === 'paid' && !hasTicket(o, guild)) status = `💰 paid, but the ticket was closed: finish it with \`/shop deliver order:${o.id}\` or \`/shop cancel\``;
  else if (!hasTicket(o, guild)) status = '✖️ closed without delivery';
  else if (o.status === 'creating') status = '⏳ opening';
  else if (o.status === 'paid') status = `💰 paid, waiting for delivery in <#${o.channelId}>`;
  else status = `🕓 waiting for payment in <#${o.channelId}>${holdExpired(o) ? ', no longer holding stock' : ''}`;
  return `**#${o.id}** ${o.product} · ${o.price} · <@${o.buyerId}> ${ago(o.createdAt)}\n${status}`;
}

async function orders(interaction, ctx) {
  const buyer = interaction.options.getUser('buyer');
  const { guild } = interaction;
  const all = Object.values(section(ctx, guild.id).orders)
    .filter(o => (!buyer || o.buyerId === buyer.id) && (o.status !== 'creating' || hasTicket(o, guild)))
    .sort((a, b) => b.id - a.id);
  if (!all.length) return ephemeral(interaction, buyer ? `${buyer} hasn't ordered anything yet.` : 'No orders yet.');
  const embed = new EmbedBuilder().setColor(ctx.color)
    .setTitle(buyer ? `Orders from ${buyer.username}` : 'Recent orders')
    .setDescription(clip(all.slice(0, RECENT).map(o => orderLine(o, guild)).join('\n'), 4096))
    .setFooter({ text: all.length > RECENT ? `Showing the ${RECENT} most recent of ${all.length}` : `${all.length} order${all.length === 1 ? '' : 's'}` });
  return ephemeral(interaction, null, { embeds: [embed] });
}

async function panel(interaction, ctx) {
  const channel = interaction.options.getChannel('channel', true);
  const s = section(ctx, interaction.guildId);
  if (!Object.keys(s.products).length) return ephemeral(interaction, 'Add a product with `/shop add` first.');
  const problem = cantPost(channel, await botMember(interaction.guild), { history: true });
  if (problem) return ephemeral(interaction, problem);
  const message = await channel.send(panelPayload(interaction.guild, ctx));
  const old = s.panel; // read after sending so concurrent /shop panel calls each retire the one they replace
  s.panel = { channelId: channel.id, messageId: message.id };
  ctx.store.save();
  if (old) {
    const oldChannel = interaction.guild.channels.cache.get(old.channelId);
    oldChannel?.messages?.delete(old.messageId).catch(() => {}); // old panel would go stale otherwise
  }
  const warn = ctx.store.guild(interaction.guildId).tickets.config ? '' : "\n⚠️ Buyers can't order until a server admin runs `/ticket setup`.";
  return ephemeral(interaction, `Shop panel posted in ${channel}. It updates whenever you use /shop add or /shop remove.${warn}`);
}

async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') return list(interaction, ctx);
  if (!isAdmin(interaction)) return ephemeral(interaction, 'You need the **Manage Server** permission to manage the shop.');
  if (sub === 'payment') return payment(interaction, ctx);
  if (sub === 'orders') return orders(interaction, ctx);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // panel posts and edits can take a moment
  if (sub === 'add') return add(interaction, ctx);
  if (sub === 'remove') return remove(interaction, ctx);
  if (sub === 'panel') return panel(interaction, ctx);
  if (sub === 'deliver') return settle(interaction, ctx, false);
  if (sub === 'cancel') return settle(interaction, ctx, true);
}

module.exports = {
  data,
  execute,
  selects: { order },
  buttons: { paid: markPaid, deliver },
  refreshPanel,
};
