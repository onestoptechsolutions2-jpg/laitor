# Laitor WhatsApp Engine — Architecture & Operations Guide

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Component Responsibilities](#2-component-responsibilities)
3. [Message Flow (End-to-End)](#3-message-flow-end-to-end)
4. [Quote → Invoice Workflow](#4-quote--invoice-workflow)
5. [Agent Assignment System](#5-agent-assignment-system)
6. [Data Model](#6-data-model)
7. [Environment Variables Reference](#7-environment-variables-reference)
8. [Twenty CRM — Configuration Guide](#8-twenty-crm--configuration-guide)
9. [Manager.io — Configuration Guide](#9-managerio--configuration-guide)
10. [API Endpoints Reference](#10-api-endpoints-reference)
11. [Deployment (Coolify + Docker Compose)](#11-deployment-coolify--docker-compose)
12. [Admin Dashboard](#12-admin-dashboard)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. System Overview

The Laitor WhatsApp Engine is a Node.js/Express backend that acts as the central nervous system for Laitor Invest Limited's customer operations.

```
WhatsApp Customer
       │
       ▼
Evolution API (WhatsApp Gateway)
       │  webhook POST /webhook/whatsapp
       ▼
┌─────────────────────────────────────┐
│        LAITOR ENGINE (Node.js)      │
│                                     │
│  Webhook Gateway → Orchestrator     │
│         │              │            │
│    Session (Redis)    CRM Service   │
│                       (Twenty)      │
│         │              │            │
│    WhatsApp Service  Manager.io     │
│    (Evolution API)   (Finance)      │
│         │                           │
│    DB Services (PostgreSQL)         │
└─────────────────────────────────────┘
```

### Design Principles

- **Phone as universal key.** `254712345678` links the same customer across WhatsApp, Twenty CRM, and Manager.io.
- **Engine is the single source of truth.** It writes to both CRM and Finance — they never talk to each other.
- **Non-blocking sync.** WhatsApp replies fire before CRM/finance calls complete. A slow API never delays the customer.
- **Quote gate before invoice.** No invoice is created without explicit customer approval (button tap).
- **Idempotent operations.** Every write to CRM or Manager.io checks for existence first (phone-based dedup).
- **Retry queue.** Failed CRM/finance pushes are queued in `sync_queue` and retried every 5 minutes.

---

## 2. Component Responsibilities

| Component | Owns | Does NOT own |
|---|---|---|
| **Engine (this codebase)** | Message routing, session state, orchestration | Long-term data storage for finance |
| **PostgreSQL (local DB)** | Contacts, orders, tickets, quotes, agents, categories, message log | Invoice accounting records |
| **Redis** | Per-customer conversation state (TTL 1 hour) | Persistent data |
| **Twenty CRM** | Sales pipeline, opportunity stages, interaction notes | Invoices, payments |
| **Manager.io** | Quotes, invoices, payments, inventory catalog | Sales pipeline stages |
| **Evolution API** | WhatsApp message delivery and receipt | Business logic |

---

## 3. Message Flow (End-to-End)

### Inbound message processing

```
1. Evolution API → POST /webhook/whatsapp
2. Webhook normalises payload → extracts phone, text, msgId
   (handles: plain text, button taps, list taps, image captions)
3. Message logged to messages table (idempotent on msg_id)
4. Admin command check → TICKET#n / ORDER#n commands handled immediately
5. STOP keyword → opt-out, return
6. Customer upsert:
   - Exists, non-import, pending consent → auto-give consent
   - Not exists → INSERT with source='inbound', consent='given'
7. CONSENT GATE (import contacts only):
   - denied → ignore silently
   - pending, first message → send consent buttons, set state=CONSENT_PENDING
   - pending, second message → parse yes/no tap, advance to KYC or MAIN_MENU
8. STATE MACHINE (consented customers):
   - KYC_NAME      → ask name, save to DB + CRM
   - KYC_LOCATION  → ask location, save to DB + CRM
   - MAIN_MENU     → route by number/button tap (1-4)
   - INTERNET_BROWSE / PRODUCT_BROWSE → show catalog items
   - INTERNET_CONFIRM / PRODUCT_CONFIRM → confirm order
   - SUPPORT_AWAIT → create ticket + notify support agent
   - QUOTE_PENDING  → handle approve/decline tap
   - AGENT_HANDOFF  → no auto-reply (human takes over)
9. Send reply via Evolution API
10. Log outbound message
```

### State transitions diagram (text)

```
NEW CONTACT (import) ──► CONSENT_PENDING ──► KYC_NAME ──► KYC_LOCATION ──► MAIN_MENU
NEW CONTACT (inbound) ──────────────────────────────────────────────────► MAIN_MENU

MAIN_MENU
  "1" ──► INTERNET_BROWSE ──► INTERNET_CONFIRM ──► (order + agent notify) ──► MAIN_MENU
  "2" ──► PRODUCT_BROWSE  ──► PRODUCT_CONFIRM  ──► (order + agent notify) ──► MAIN_MENU
  "3" ──► SUPPORT_AWAIT   ──► (ticket + agent notify)                     ──► MAIN_MENU
  "4" ──► AGENT_HANDOFF   (human takes over — no auto-reply)

QUOTE_PENDING (set via admin dashboard)
  QUOTE_APPROVE tap ──► invoice created → CRM WON → finance agent notified ──► MAIN_MENU
  QUOTE_DECLINE tap ──► CRM LOST → sales agent notified                    ──► MAIN_MENU

ANY STATE: "stop" / "STOP" ──► opted out (consent='denied', messages ignored)
ANY STATE: "menu" / "hi"   ──► MAIN_MENU (resets to top)
```

---

## 4. Quote → Invoice Workflow

### Step-by-step

1. **Agent creates quote** via Admin Dashboard → Quotes → Send Quote
   - Enters customer phone + line items (name, qty, price)
   - System finds customer in DB (must exist — import or prior contact)

2. **Engine creates records:**
   - Inserts row in `quotes` table with status='draft'
   - Creates Sales Quote in Manager.io (reference: `WA-QUOTE-{id}`)
   - Sets status='sent', records `sent_at`

3. **Customer receives WhatsApp message:**
   - Quote summary with line items + total
   - Two buttons: ✅ Approve Quote / ❌ Decline
   - Customer session set to `QUOTE_PENDING`

4. **Customer taps Approve:**
   - Engine creates Sales Invoice in Manager.io (reference: `WA-INV-{id}`)
   - Quote status → 'invoiced', `approved_at` recorded
   - Linked order `invoice_ref` updated
   - Twenty CRM opportunity stage → WON, invoice ref added as note
   - Finance agent notified via WhatsApp
   - Customer receives: invoice ref + next steps message

5. **Customer taps Decline:**
   - Quote status → 'declined', `declined_at` recorded
   - Twenty CRM opportunity stage → LOST
   - Category agent notified to follow up
   - Customer receives polite decline confirmation

### Creating a quote from the admin dashboard

```
POST /api/v1/quotes
{
  "phone": "254712345678",
  "items": [
    { "name": "Home Fibre 10Mbps", "qty": 1, "price": 3500 },
    { "name": "Router installation", "qty": 1, "price": 500 }
  ],
  "notes": "1-month contract, includes installation"
}
```

---

## 5. Agent Assignment System

### How it works

Each team member (agent) is assigned one or more categories:
- `internet` — handles internet package leads
- `products` — handles CCTV, routers, equipment orders
- `support` — handles technical support tickets
- `finance` — receives invoice and payment notifications
- `general` — catch-all fallback

When an event occurs (new lead, order, ticket, quote approval), the engine:
1. Queries `agents` table for an active agent with that category
2. Sends them a WhatsApp notification with customer details and reference number
3. Falls back to `ADMIN_PHONES` env var if no agent is configured

### Managing agents

Via Admin Dashboard → Agents:
- Add agents with name + WhatsApp phone number
- Check the categories they handle
- Set an escalation phone (manager) for that agent
- Deactivate without deleting

Via `ADMIN_PHONES` env var: comma-separated phones that receive all notifications (fallback + admin commands).

### Admin commands (via WhatsApp)

Send from a phone listed in `ADMIN_PHONES`:

```
TICKET#42 RESOLVED John Kamau      → closes ticket, updates customer
TICKET#42 IN_PROGRESS              → sets in-progress
ORDER#7 CONFIRMED                  → confirms order, triggers Manager.io invoice
ORDER#7 FULFILLED                  → marks fulfilled, updates customer
ORDER#7 CANCELLED                  → cancels, updates customer
```

---

## 6. Data Model

### customers
Primary contact record. Phone is the unique key across all systems.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL | Internal PK |
| phone | VARCHAR(20) UNIQUE | E.164-ish, e.g. 254712345678 |
| name | VARCHAR(255) | Collected via KYC or import |
| location | VARCHAR(255) | Area/estate — collected via KYC |
| crm_id | VARCHAR(255) | Twenty CRM person ID |
| manager_key | VARCHAR(255) | Manager.io customer key |
| consent_status | VARCHAR(20) | pending / given / denied |
| source | VARCHAR(50) | import / inbound / web / referral / social |
| cluster / territory | VARCHAR(255) | From Excel import |

### quotes
Pending quote records — approval gate before invoicing.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL | Local ID, used in WA-QUOTE-{id} ref |
| customer_id | INT FK | Links to customers |
| manager_quote_ref | VARCHAR | Manager.io quote key |
| status | VARCHAR | draft / sent / approved / invoiced / declined |
| items | JSONB | [{name, qty, price}] |
| total_amount | DECIMAL | Sum of line items |
| approved_at / declined_at | TIMESTAMPTZ | Set on customer tap |

### agents
Team members who receive category-based notifications.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL | |
| name | VARCHAR | Display name |
| phone | VARCHAR(20) UNIQUE | WhatsApp number for notifications |
| categories | TEXT[] | e.g. {internet, support} |
| escalation_phone | VARCHAR | Manager to notify on escalation |
| active | BOOLEAN | Soft-delete |

### sync_queue
Retry queue for failed CRM/Manager.io pushes.

| Column | Type | Notes |
|---|---|---|
| entity_type | VARCHAR | customer / lead / order / ticket / quote |
| entity_id | VARCHAR | Local DB ID |
| target | VARCHAR | crm / manager / whatsapp |
| payload | JSONB | Data to retry with |
| status | VARCHAR | pending / retrying / completed / dead |
| attempts | INT | Max 3, then status='dead' |

---

## 7. Environment Variables Reference

All variables set in Coolify → Service → Environment Variables.

### Required

| Variable | Example | Notes |
|---|---|---|
| `EVOLUTION_API_URL` | `https://evolution.laitor.co.ke` | Evolution API base URL |
| `EVOLUTION_API_KEY` | `your-evolution-key` | From Evolution API dashboard |
| `EVOLUTION_INSTANCE` | `laitor` | Instance name in Evolution API |
| `DATABASE_URL` | `postgresql://laitor:pass@laitor_db:5432/laitor` | Auto-set if using Docker Compose |
| `REDIS_URL` | `redis://laitor_cache:6379` | Auto-set if using Docker Compose |
| `CRM_URL` | `https://crm.laitor.co.ke` | **No trailing slash** |
| `CRM_API_KEY` | `eyJ...` | Twenty Settings → API & Webhooks |

### Optional but recommended

| Variable | Example | Notes |
|---|---|---|
| `MANAGER_URL` | `https://finance360.laitor.co.ke/api2` | **Must be HTTPS** — HTTP redirects strip auth header |
| `MANAGER_API_KEY` | `your-manager-token` | Manager.io Settings → API |
| `ADMIN_PHONES` | `254712345678,254722222222` | Comma-separated, no spaces |
| `WEBHOOK_SECRET` | `random-secret-string` | Validates Evolution API webhooks |
| `SESSION_TTL_SECONDS` | `3600` | Redis session TTL (default: 1 hour) |
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | |

---

## 8. Twenty CRM — Configuration Guide

### Steps to configure

1. **Get your API key:**
   Twenty → Settings → API & Webhooks → Generate API Key
   Copy the full token.

2. **Set env vars:**
   ```
   CRM_URL=https://crm.laitor.co.ke    ← no trailing slash!
   CRM_API_KEY=eyJ...
   ```

3. **Verify in Twenty that these objects exist:**
   - **People** — must have `phones` field (default in Twenty)
   - **Opportunities** — must have `stage`, `amount`, `closeDate`, `pointOfContactId` fields
   - Opportunity stage must support: `NEW_LEAD`, `PROPOSAL_SENT`, `WON`, `LOST`

4. **Test the connection** (from server):
   ```bash
   curl -X POST https://crm.laitor.co.ke/graphql \
     -H "Authorization: Bearer YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d '{"query":"{ people(first:1) { edges { node { id } } } }"}'
   ```
   Expected: `{"data":{"people":{"edges":[...]}}}`

### Opportunity stage values (valid in Twenty)

```
NEW_LEAD | CONTACTED | MEETING_SCHEDULED | PROPOSAL_SENT | NEGOTIATION | WON | LOST
```

### What the engine writes to Twenty

| Trigger | Action |
|---|---|
| New inbound/consent | `createPerson` (if not exists) |
| KYC name collected | `updatePerson` name |
| KYC location collected | `updatePerson` city |
| Interest detected | `createOpportunity` stage=NEW_LEAD |
| Quote sent | `updateOpportunity` stage=PROPOSAL_SENT |
| Quote approved | `updateOpportunity` stage=WON + note with invoice ref |
| Quote declined | `updateOpportunity` stage=LOST |
| Any interaction | `createNote` with message preview |

---

## 9. Manager.io — Configuration Guide

### Steps to configure

1. **Get your API token:**
   Manager.io → Settings → API → Copy access token

2. **Set env vars:**
   ```
   MANAGER_URL=https://finance360.laitor.co.ke/api2    ← MUST be HTTPS
   MANAGER_API_KEY=your-access-token
   ```
   **Critical:** Use HTTPS directly. If you use HTTP, the server redirects to HTTPS and the redirect strips the Authorization header, causing 401 errors.

3. **Enable required modules in Manager.io:**
   - Sales Quotes module (for quote creation)
   - Sales Invoices module (for invoice creation)
   - Inventory Items module (for catalog sync)
   - At least one bank/cash account (required by invoice module)

4. **Create a custom field on Customers:**
   Manager.io → Settings → Custom Fields → Customers → Add field: name=`Phone`, type=Text
   This allows the engine to find customers by phone number.

5. **Test the connection:**
   ```bash
   curl -s -H "Authorization: Bearer YOUR_TOKEN" \
     https://finance360.laitor.co.ke/api2/customers | head -c 200
   ```
   Expected: JSON array of customers (even if empty: `[]`)

### What the engine writes to Manager.io

| Trigger | Action |
|---|---|
| New contact on order/quote | `POST /customers` (or find existing) |
| Quote created via admin | `POST /sales-quotes` ref=WA-QUOTE-{id} |
| Customer approves quote | `POST /sales-invoices` ref=WA-INV-{id} |
| Admin confirms order (legacy) | `POST /sales-invoices` ref=WA-ORDER-{id} |
| Startup catalog sync | `GET /inventory-items` or `GET /items` |

### Troubleshooting Manager.io 401 errors

1. Verify the token from Manager.io Settings → API
2. Ensure `MANAGER_URL` starts with `https://` not `http://`
3. The engine sends `Authorization: Bearer <token>` — confirm your Manager.io version accepts this format
4. If still failing, check Manager.io API token permissions (must not be read-only)

---

## 10. API Endpoints Reference

All endpoints are under `/api/v1/` (admin use only — no auth currently).

### Stats & overview
```
GET /api/v1/stats            — dashboard counts + sync queue status
```

### Customers
```
GET /api/v1/customers        — list (params: q, source, consent, limit, offset)
```

### Orders & Tickets
```
GET /api/v1/orders           — list (param: status)
GET /api/v1/tickets          — list (param: status)
```

### Catalog
```
GET    /api/v1/catalog           — full catalog (Manager.io + manual)
GET    /api/v1/catalog/items     — manual DB items only
POST   /api/v1/catalog/items     — add item {name, description, price, type}
PUT    /api/v1/catalog/items/:id — update item
DELETE /api/v1/catalog/items/:id — delete item
POST   /api/v1/catalog/refresh   — clear cache + re-pull from Manager.io
```

### Quotes
```
GET  /api/v1/quotes          — list quotes (param: status)
POST /api/v1/quotes          — create + send quote {phone, items:[{name,qty,price}], notes?}
```

### Agents
```
GET    /api/v1/agents          — list all agents
POST   /api/v1/agents          — create {name, phone, categories[], email?, escalation_phone?}
PUT    /api/v1/agents/:id      — update agent
DELETE /api/v1/agents/:id      — deactivate (soft delete)
```

### Categories
```
GET    /api/v1/categories          — list all categories
POST   /api/v1/categories          — create {name, manager_group_key?, display_order?}
PUT    /api/v1/categories/:id      — update
DELETE /api/v1/categories/:id      — hard delete
```

### Sync Queue
```
GET  /api/v1/sync-queue            — queue stats + dead items
POST /api/v1/sync-queue/retry/:id  — re-queue a dead item
```

### Contacts (import)
```
POST /contacts/import        — multipart file upload (.xlsx), field='file', ?blast=true
POST /contacts/blast         — send outreach to pending contacts {territory?, cluster?}
GET  /contacts/pending       — list pending contacts
```

### Web leads
```
POST /leads/web              — {phone, name?, service?, location?, source, referred_by?, notes?}
GET  /leads/sources          — list valid source values
```

### Webhooks
```
POST /webhook/whatsapp       — Evolution API webhook (all inbound events)
GET  /health                 — liveness check
```

---

## 11. Deployment (Coolify + Docker Compose)

### Stack
- `laitor_app` — Node.js Express app (port 3000)
- `laitor_db`  — PostgreSQL 15
- `laitor_cache` — Redis 7

### Coolify settings
- **Build pack:** Docker Compose
- **Compose file location:** `/docker-compose.yaml`
- **Domain:** `https://engine.laitor.co.ke`

### On each deploy, the entrypoint automatically:
1. Waits for PostgreSQL to be ready (netcat check)
2. Runs `node src/models/migrate.js` (schema is idempotent — safe to re-run)
3. Starts `node src/index.js`

### First-time setup checklist

1. Push code to GitHub
2. Create Coolify project, point to repo
3. Set all env vars (see Section 7)
4. Deploy — migration runs automatically
5. Configure Evolution API webhook:
   - URL: `https://engine.laitor.co.ke/webhook/whatsapp`
   - Events: `messages.upsert`
6. Test: send "hi" to your WhatsApp number

---

## 12. Admin Dashboard

Access at: `https://engine.laitor.co.ke/admin`

### Sections

| Section | Purpose |
|---|---|
| Dashboard | Live counts: contacts, leads, orders, tickets + recent activity |
| Contacts | Browse/search contacts, import Excel file, filter by consent |
| Orders | View order status, track by product |
| Tickets | Open ticket queue with priority |
| Outreach | Send consent messages to imported contacts (blast) |
| Catalog | Manage product/service catalog items (add/edit/delete), refresh from Manager.io |
| **Quotes** | Send quotes to customers, track approve/decline status |
| **Agents** | Configure team agents with category assignments |
| **Categories** | Manage product categories with Manager.io group mapping |
| Add Lead | Manually add leads from website, referral, social, walk-in |

### Excel import format

Required columns (exact names):

| Customer | Mobile phone | Service | Location | Cluster | Territories |
|---|---|---|---|---|---|
| Jane Wanjiku | 254712345678 | Fibre | Westlands | Nairobi West | Westlands |

- If `Territories` column is empty, the filename (without extension) is used as the territory name
- Imported contacts get `source='import'` and `consent_status='pending'`
- Use the Outreach blast to send consent messages after import

---

## 13. Troubleshooting

### CRM not syncing

1. Check `CRM_URL` — must NOT have a trailing slash
2. Run: `curl -X POST $CRM_URL/graphql -H "Authorization: Bearer $CRM_API_KEY" -d '{"query":"{ __typename }"}'`
3. Look for `"data":{"__typename":"Query"}` — if you see an error, the key is wrong

### Manager.io 401 Unauthorized

1. Ensure `MANAGER_URL` uses `https://` directly
2. Confirm the token has full (not read-only) permissions in Manager.io Settings → API
3. Test: `curl -s -H "Authorization: Bearer $MANAGER_API_KEY" $MANAGER_URL/customers`

### Catalog shows empty

Manager.io not returning inventory items. Workaround: add items manually via Admin → Catalog.
The engine will use manual items for the WhatsApp menu while Manager.io is being set up.

### WhatsApp not sending

1. Check Evolution API dashboard — confirm the `laitor` instance shows as connected (green)
2. Verify `EVOLUTION_API_URL` and `EVOLUTION_API_KEY` in Coolify env vars
3. Check logs: `docker logs laitor_app | grep "whatsapp\|Evolution"`

### Messages not arriving

1. Check webhook is set in Evolution: `https://engine.laitor.co.ke/webhook/whatsapp`
2. Test webhook delivery: `GET https://engine.laitor.co.ke/health` should return `{"status":"ok"}`
3. Check engine logs for `Webhook: inbound message received`

### Session stuck in wrong state

The customer's session state is stored in Redis with a 1-hour TTL.
Customer can reset by sending: `menu` or `hi` — this always resets to MAIN_MENU.

### Database migration failed on deploy

Check Coolify logs for `[migrate] FAILED`. Common causes:
- `DATABASE_URL` env var not set correctly
- PostgreSQL container not healthy yet (entrypoint has a wait loop — usually self-resolves on retry)

### git index.lock error (Windows)

If git shows `index.lock` error, run from Windows terminal (not sandbox):
```
del .git\index.lock
```

---

*Last updated: June 2026 · Laitor Invest Limited*
