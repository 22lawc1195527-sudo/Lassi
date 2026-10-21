// Amul stock Telegram bot.
//   node bot.mjs once    -> read new Telegram commands, check stock, alert, exit (for GitHub Actions / cron)
//   node bot.mjs serve   -> stay running: instant replies + a check every CHECK_EVERY_MIN minutes
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { SUBSTORES, CATEGORIES, fetchAmulProducts, isInStock, stockCount, productUrl } from './amul.mjs'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATE_FILE = process.env.STATE_FILE || 'state.json'
const CHECK_EVERY_MIN = Number(process.env.CHECK_EVERY_MIN || 5)
if (!TOKEN) { console.error('Set TELEGRAM_BOT_TOKEN'); process.exit(1) }

// ---------- state ----------
const DEFAULT_STATE = {
  ownerChatId: process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : null,
  pincode: process.env.PINCODE || '',
  keywords: ['lassi'],
  previous: {},       // alias -> in stock at last check
  products: [],       // last product list (for /stock and /list)
  updateOffset: 0,
  lastCheck: null,
  region: '',
  errorStreak: 0
}
async function loadState() {
  try { return { ...DEFAULT_STATE, ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) } }
  catch { return { ...DEFAULT_STATE } }
}
const saveState = s => fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2))

// ---------- telegram ----------
async function tg(method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  })
  const j = await r.json()
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`)
  return j.result
}
const say = (chatId, text, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const HELP = [
  '<b>Amul stock bot</b>',
  '/pincode 110001 — set your delivery pincode',
  '/watch rose lassi — alert me when matching products are back',
  '/unwatch rose lassi — stop watching',
  '/list — what you watch and its stock now',
  '/stock — everything in stock right now',
  '/check — check now',
  '/help — this message'
].join('\n')

// ---------- amul ----------
async function loadProducts(pincode) {
  const browser = await chromium.launch()
  try {
    const ctx = await browser.newContext({
      locale: 'en-IN',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
    })
    const page = await ctx.newPage()
    await page.goto('https://shop.amul.com/en/browse/protein', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(2500) // let the site set its session cookies
    const call = `(${fetchAmulProducts.toString()})(${JSON.stringify(pincode)}, ${JSON.stringify(CATEGORIES)}, ${JSON.stringify(SUBSTORES)}, false)`
    return await page.evaluate(call)
  } finally {
    await browser.close()
  }
}

const matches = (p, keywords) => keywords.some(k => p.name.toLowerCase().includes(k.toLowerCase()))

async function check(state) {
  if (!state.pincode) return
  try {
    const { products, region } = await loadProducts(state.pincode)
    const now = {}
    const back = []
    for (const p of products) {
      now[p.alias] = isInStock(p)
      if (now[p.alias] && state.previous[p.alias] === false && matches(p, state.keywords)) back.push(p)
    }
    state.products = products.map(p => ({
      alias: p.alias, name: p.name, price: p.price, inStock: now[p.alias],
      qty: stockCount(p), categories: p.categories, url: productUrl(p)
    }))
    state.previous = now
    state.region = region
    state.lastCheck = Date.now()
    if (state.errorStreak >= 3 && state.ownerChatId) await say(state.ownerChatId, '✅ Amul checks are working again.')
    state.errorStreak = 0
    console.log(`Checked ${products.length} products (${region}); ${back.length} back in stock`)

    if (state.ownerChatId) {
      for (const p of back) {
        const qty = stockCount(p)
        await say(state.ownerChatId,
          `🥛 <b>Back in stock</b>\n${esc(p.name)}\n₹${p.price}${qty ? ` · ${qty} left` : ''}`,
          { reply_markup: { inline_keyboard: [[{ text: 'Open on Amul shop', url: productUrl(p) }]] } })
      }
    }
  } catch (e) {
    state.errorStreak = (state.errorStreak || 0) + 1
    console.error('Check failed:', e.message)
    if (state.errorStreak === 3 && state.ownerChatId) {
      await say(state.ownerChatId, `⚠️ Amul checks have failed 3 times in a row:\n<code>${esc(e.message)}</code>`)
    }
  }
}

// ---------- commands ----------
function listText(state) {
  if (!state.products.length) return 'No data yet — send /check.'
  const watched = state.products.filter(p => matches(p, state.keywords))
  const lines = watched
    .sort((a, b) => (b.inStock - a.inStock) || a.name.localeCompare(b.name))
    .map(p => `${p.inStock ? '✅' : '❌'} <a href="${p.url}">${esc(p.name)}</a>${p.inStock && p.qty ? ` (${p.qty})` : ''}`)
  return `<b>Watching:</b> ${state.keywords.map(esc).join(', ') || '(nothing)'}\n` +
    (lines.length ? lines.join('\n') : 'No products match those words.') + footer(state)
}
function stockText(state) {
  if (!state.products.length) return 'No data yet — send /check.'
  const inStock = state.products.filter(p => p.inStock).sort((a, b) => a.name.localeCompare(b.name))
  if (!inStock.length) return 'Nothing in stock right now.' + footer(state)
  return `<b>In stock (${inStock.length}):</b>\n` +
    inStock.map(p => `• <a href="${p.url}">${esc(p.name)}</a> — ₹${p.price}`).join('\n') + footer(state)
}
function footer(state) {
  if (!state.lastCheck) return ''
  const mins = Math.round((Date.now() - state.lastCheck) / 60000)
  return `\n\n<i>${state.pincode} · ${state.region} · checked ${mins < 1 ? 'just now' : mins + ' min ago'}</i>`
}

// Reads new messages. Settings commands are answered at once; questions about
// stock are returned so they can be answered after a fresh check.
async function readCommands(state, longPollSec = 0) {
  const updates = await tg('getUpdates', { offset: state.updateOffset, timeout: longPollSec, allowed_updates: ['message'] })
  const pending = []
  for (const u of updates) {
    state.updateOffset = u.update_id + 1
    const msg = u.message
    if (!msg || !msg.text) continue
    const chatId = msg.chat.id
    const [rawCmd, ...rest] = msg.text.trim().split(/\s+/)
    const cmd = rawCmd.split('@')[0].toLowerCase()
    const arg = rest.join(' ').trim()

    if (!state.ownerChatId && cmd === '/start') {
      state.ownerChatId = chatId
      await say(chatId, 'This bot is now yours. 👋\n\n' + HELP + (state.pincode ? '' : '\n\nStart with /pincode followed by your pincode.'))
      continue
    }
    if (chatId !== state.ownerChatId) { await say(chatId, 'Sorry, this is a private bot.'); continue }

    switch (cmd) {
      case '/start':
      case '/help':
        await say(chatId, HELP); break
      case '/pincode':
        if (!/^\d{6}$/.test(arg)) { await say(chatId, 'Send it like: /pincode 110001'); break }
        state.pincode = arg; state.previous = {}; state.products = []
        await say(chatId, `Pincode set to ${arg}. Checking…`)
        pending.push({ chatId, cmd: '/list' }); break
      case '/watch':
        if (!arg) { await say(chatId, 'Send it like: /watch rose lassi'); break }
        if (!state.keywords.includes(arg.toLowerCase())) state.keywords.push(arg.toLowerCase())
        await say(chatId, `Watching anything matching “${esc(arg)}”.`)
        pending.push({ chatId, cmd: '/list' }); break
      case '/unwatch': {
        const before = state.keywords.length
        state.keywords = state.keywords.filter(k => k !== arg.toLowerCase())
        await say(chatId, before === state.keywords.length
          ? `Not watching “${esc(arg)}”. You watch: ${state.keywords.map(esc).join(', ') || 'nothing'}`
          : `Stopped watching “${esc(arg)}”.`)
        break
      }
      case '/list': case '/stock': case '/check':
        pending.push({ chatId, cmd }); break
      default:
        await say(chatId, HELP)
    }
  }
  return pending
}

async function answer(state, pending) {
  for (const { chatId, cmd } of pending) {
    if (!state.pincode) { await say(chatId, 'Set your pincode first: /pincode 110001'); continue }
    await say(chatId, cmd === '/stock' ? stockText(state) : listText(state))
  }
}

// ---------- modes ----------
async function once() {
  const state = await loadState()
  const pending = await readCommands(state)
  await check(state)
  await answer(state, pending)
  await saveState(state)
}

async function serve() {
  const state = await loadState()
  await tg('deleteWebhook')
  console.log(`Serving. Checking every ${CHECK_EVERY_MIN} min.`)
  let nextCheck = 0
  for (;;) {
    try {
      const pending = await readCommands(state, 25)
      const wantsFresh = pending.some(p => p.cmd === '/check') || pending.length && !state.products.length
      if (Date.now() >= nextCheck || wantsFresh) {
        await check(state)
        nextCheck = Date.now() + CHECK_EVERY_MIN * 60000
      }
      await answer(state, pending)
      await saveState(state)
    } catch (e) {
      console.error(e.message)
      await new Promise(r => setTimeout(r, 10000))
    }
  }
}

const mode = process.argv[2] || 'once'
await (mode === 'serve' ? serve() : once())
