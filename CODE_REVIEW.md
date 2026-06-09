# Laitor WhatsApp Engine — Code Review
*Reviewed: June 2026 · claude-sonnet-4-6*

---

## What This Is

A Node.js/Express backend that acts as a WhatsApp-native business operating system for Laitor Invest Limited. Customers text a WhatsApp number; a state machine routes them through internet/product menus, KYC, quotes, support tickets, and a full marketplace — all over chat. The engine simultaneously syncs contacts to a Twenty CRM (GraphQL) and Manager.io finance platform (REST), queues retries for failures, and exposes an admin dashboard for the team.

The scope is genuinely impressive: 16 DB tables, M-Pesa STK push payments, a bidirectional CRM↔Manager.io sync, campaign broadcasts, commission tracking, delivery management, and a self-contained JWT admin auth system — all in one codebase.

---

## Bugs (Will Crash in Production)

### 1. `sess` used before it is declared — new customers crash

**File:** `src/orchestrator/index.js`, around line 494

```js
// NEW CUSTOMER BRANCH
const res = await query(`INSERT INTO customers ...`);
customer = res.rows[0];
if (!sess.welcomed) {           // ← ReferenceError: Cannot access 'sess' before initialization
  const cfgStore = require(...);
  ...
}

// ...10 lines later...
const sess = await session.get(phone);   // declared here
```

`sess` is a `const` declared after the new-customer branch, so JavaScript's temporal dead zone makes the earlier reference throw a `ReferenceError`. This means **every first-time inbound customer** triggers an unhandled error in the orchestrator. The welcome message is never sent, and depending on error recovery, the conversation may stall.

**Fix:** Move `const sess = await session.get(phone)` to before the `try { const existing = ...}` block.

---

### 2. `supabaseSync` called without an import in `checkout.js`

**File:** `src/services/marketplace/checkout.js`, after `createOrder()`

```js
supabaseSync.syncOrder(order, summary.items.map(...)).catch(() => {});
```

`supabaseSync` is never imported in this file. This is a `ReferenceError` in synchronous code — the `.catch()` only catches async rejections, not synchronous throws. Calling `createOrder()` will always throw after the DB writes succeed, rolling back what was just done in the caller's try/catch.

**Fix:** Either add `const supabaseSync = require('../supabaseSync')` at the top of the file, or remove the call (Supabase sync appears to be an abandoned integration path judging by `supabaseAuth.js`).

---

### 3. `req.user` instead of `req.admin` in change-password route

**File:** `src/routes/auth.js`, `POST /auth/change-password`

```js
const { rows } = await query('SELECT * FROM admin_users WHERE id=$1', [req.user.id]);
//                                                                       ^^^^^^^^
// The middleware sets req.admin, not req.user. This is always undefined.
```

Every password-change attempt throws `TypeError: Cannot read properties of undefined (reading 'id')`.

**Fix:** Replace `req.user.id` with `req.admin.id` (two occurrences in that handler).

---

### 4. `sync_queue.enqueue()` ON CONFLICT references a non-existent unique constraint

**File:** `src/services/sync-queue.js` + `src/models/migrate.js`

```js
// enqueue() does:
INSERT INTO sync_queue (...) ON CONFLICT (entity_type, entity_id, target) DO UPDATE ...
```

The migration creates `sync_queue` with only a `SERIAL PRIMARY KEY`. There is no `UNIQUE` constraint on `(entity_type, entity_id, target)`. PostgreSQL will throw `ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification`. This error is caught and swallowed in `enqueue()`, so **nothing is ever added to the retry queue**. Failed CRM and Manager.io pushes silently disappear.

**Fix:** Add to the migration:
```sql
ALTER TABLE sync_queue ADD CONSTRAINT uq_sync_queue_entity 
  UNIQUE (entity_type, entity_id, target);
```

---

### 5. Sync queue retry handlers are never registered

**File:** `src/services/sync-queue.js` + `src/index.js`

`registerHandler(target, handler)` is exported but called nowhere in the codebase. `processQueue()` runs every 5 minutes, finds pending items, then hits:

```js
const handler = handlers[item.target];
if (!handler) {
  logger.warn('sync-queue: no handler for target', ...);
  continue;   // skips every item
}
```

The retry worker runs on schedule and silently does nothing. Even if bug #4 is fixed and items reach the queue, they will never be retried.

**Fix:** In `src/index.js`, after `syncQueue.startWorker()`, register handlers:
```js
syncQueue.registerHandler('crm',     async (item) => { /* call crm service with item.payload */ });
syncQueue.registerHandler('manager', async (item) => { /* call manager service with item.payload */ });
```

---

## Security Issues

### 6. The entire `/api/v1/` admin API has no authentication

**File:** `src/routes/api.js`

The comment in the file says `"admin use only — no auth currently"`. The `adminAuth` middleware is built and working in `auth.js`, but it is never imported or applied to `api.js`. Any unauthenticated request from the internet can:

- List all customers, phone numbers, names, and locations — `GET /api/v1/customers`
- Send quotes to any customer — `POST /api/v1/quotes`
- Create or modify agents — `POST /api/v1/agents`
- Trigger a full CRM sync — `POST /api/v1/sync/all`
- Read all orders and tickets

**Fix:** Import and apply `adminAuth` to the router:
```js
const { adminAuth } = require('./auth');
router.use(adminAuth);   // protects all /api/v1/ routes
```

---

### 7. Webhook has no signature validation

**File:** `src/routes/webhook.js`

`WEBHOOK_SECRET` is documented in the architecture guide and in `.env.example`, but the webhook route never checks it. Any HTTP client can POST to `/webhook/whatsapp` and inject arbitrary messages — including fake admin commands (`ORDER#7 CONFIRMED`, `TICKET#42 RESOLVED`).

**Fix:**
```js
router.post('/', (req, res, next) => {
  const secret = process.env.WEBHOOK_SECRET;
  const header = req.headers['x-evolution-signature'] || req.headers['x-webhook-secret'];
  if (secret && header !== secret) return res.status(401).end();
  next();
}, async (req, res) => { ... });
```
(Confirm the exact header name Evolution API sends.)

---

### 8. Default admin credentials printed to stdout on every fresh deploy

**File:** `src/models/migrate.js`

```js
console.log(`[migrate]   Password : ${password}`);
```

The default password `Laitor@2024` (or whatever `ADMIN_DEFAULT_PASSWORD` is set to) is printed in cleartext to the container logs on every first-boot migration. If logs are forwarded to Coolify, a logging service, or any cloud aggregator, credentials are exposed there in plaintext.

**Fix:** Remove the password line from the log output. A reminder to change it is enough:
```js
console.log('[migrate]   ⚠  Set a strong password via Admin → Users before going live!');
```

---

## Design Observations

### Dead variable `shopTriggers`

**File:** `src/orchestrator/index.js`

```js
const shopTriggers = ['shop','shopping','marketplace','buy','store','browse catalog','cart','my cart','checkout','track order'];
const tLow = (text || '').toLowerCase().trim();
if (tLow === 'shop' || tLow === 'shopping' || tLow === 'marketplace' || tLow === '🛍️ shop') {
```

`shopTriggers` is defined but then the check below it manually re-lists a subset of the values. The variable is never used. It looks like the intent was `shopTriggers.includes(tLow)` but it got replaced with an ad-hoc check. The inconsistency means keywords like `'buy'`, `'store'`, and `'browse catalog'` in the array never actually trigger the shopping flow.

---

### `handleCheckoutAddress` conflates two different states

The function both *initiates* the checkout (showing the address prompt when `text === 'CHECKOUT_START'`) and *processes* the typed address. This means a single function has two completely different control flows depending on what phase it's in. For a state machine, these should be two separate handlers (`CHECKOUT_START_HANDLER` → transitions to `CHECKOUT_ADDRESS` state → separate `handleAddressInput`). As it stands, any text longer than 10 characters typed while the customer is still in `SHOPPING_CART` state could be misinterpreted as a delivery address.

---

### `catalog/refresh` deletes by `raw IS NOT NULL`

**File:** `src/routes/api.js`

```js
await query(`DELETE FROM catalog_cache WHERE raw IS NOT NULL`);
```

This heuristic (Manager.io items have a raw JSON payload, manual items do not) is fragile and undocumented. If a future code path ever sets `raw` on a manual item, it would be silently deleted on the next refresh. A cleaner approach is an explicit `source` column: `WHERE source = 'manager'`.

---

### Per-phone race condition on concurrent messages

If the same phone sends two messages in quick succession (both delivered by Evolution API within milliseconds of each other), two orchestrator instances can run concurrently for the same customer. Both read the same Redis session, both compute a `nextState`, and the second write wins — potentially discarding the state from the first. For high-traffic numbers this could produce inconsistent conversation behavior.

A simple fix is an advisory lock per phone in Redis (a `SETNX` before processing, released after `session.set()`).

---

### No rate limiting

The webhook endpoint and the API routes have no rate limiting. A flood of webhook events for one phone (or a burst of admin API calls) will hit PostgreSQL with uncapped concurrency. Express apps in production typically sit behind Nginx or Caddy where rate limiting can be configured, but it's worth adding `express-rate-limit` at the app layer as a second line of defense.

---

## What's Done Well

**Architecture documentation.** `ARCHITECTURE.md` is one of the best I've seen in a project this size — the state machine diagram, the data model table, the env var reference, the troubleshooting section. Someone new to the codebase can understand the entire system in under an hour.

**Non-blocking WhatsApp replies.** The orchestrator sends the reply first, then syncs to CRM and Manager.io. A slow external API never makes a customer wait. The sync queue catches and retries failures. This is the right design.

**Graceful degradation is consistent.** Every CRM and Manager.io call is wrapped in a `safe()` helper that logs and returns null. The WhatsApp conversation continues regardless of whether the external systems respond.

**Message idempotency.** `ON CONFLICT (msg_id) DO NOTHING` on the messages table means Evolution API retries don't produce duplicate log entries or double-process a message.

**WhatsApp send retry with exponential backoff.** `sendText()` retries up to 3 times with 1s/2s/4s delays, and rich message types (buttons, list) fall back to plain text if Evolution API rejects them. This makes the bot resilient to transient WhatsApp API issues.

**Self-contained JWT auth.** Using Node's built-in `crypto` for HS256 signing instead of pulling in `jsonwebtoken` is a good call — one fewer dependency, no supply chain risk, and the implementation is clear and correct (timing-safe comparison, expiry check, dual Bearer + cookie support).

**Phone as universal key.** The decision to normalize phone numbers as the deduplication key across PostgreSQL, Twenty CRM, and Manager.io is clean and correct. It avoids the usual mess of mismatched IDs across systems.

**M-Pesa integration.** Full STK push → callback → receipt flow with graceful fallback to manual payment confirmation (`PAID <code>`) when the STK push fails. The token caching with `_tokenExpiresAt` avoids hitting the Daraja auth endpoint on every payment.

**Idempotent migration.** The entire schema uses `CREATE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN IF NOT EXISTS`. Running it on an existing database is safe. The `ON CONFLICT DO NOTHING` seeds are clean.

**Scope.** Campaigns, broadcasts, lead scoring, commission tracking, delivery management, shipping zones, discount codes, product variants — this is far more than a WhatsApp bot. It's a full business operations platform built natively on WhatsApp as the UX layer.

---

## Priority Fix List

| # | Issue | Severity | File |
|---|-------|----------|------|
| 1 | `sess` used before declaration — new customers crash | Critical | `orchestrator/index.js` |
| 2 | `supabaseSync` ReferenceError in checkout | Critical | `marketplace/checkout.js` |
| 3 | `req.user` vs `req.admin` in change-password | High | `routes/auth.js` |
| 4 | Missing UNIQUE constraint breaks sync queue enqueue | High | `models/migrate.js` |
| 5 | Sync queue handlers never registered — retries are no-ops | High | `index.js` |
| 6 | `/api/v1/` has no authentication | High | `routes/api.js` |
| 7 | Webhook has no signature validation | Medium | `routes/webhook.js` |
| 8 | Default password logged in plaintext | Medium | `models/migrate.js` |
| 9 | `shopTriggers` dead variable — keywords 'buy', 'store' never work | Low | `orchestrator/index.js` |
| 10 | `catalog/refresh` deletes by fragile `raw IS NOT NULL` heuristic | Low | `routes/api.js` |
