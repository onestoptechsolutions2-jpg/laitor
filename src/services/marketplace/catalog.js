'use strict';

/**
 * @module marketplace/catalog
 * @description Product catalog service for the WhatsApp marketplace.
 *
 * Handles:
 *  - Category management
 *  - Product CRUD with automatic markup calculation
 *  - Paginated browsing (WhatsApp list-message compatible: 10 items/page)
 *  - Full-text search
 *
 * PRICING LOGIC (applied in computePrice):
 *  1. If product.sell_price is set → use it directly (manual override)
 *  2. Else: sell_price = cost_price * (1 + effective_markup / 100)
 *     where effective_markup = product.markup_pct ?? category.markup_pct ?? 20
 */

const { query } = require('../../models/db');
const logger    = require('../../utils/logger');

const PAGE_SIZE = 10; // WhatsApp list message limit

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Compute the sell price for a product row (with category joined).
 * @param {object} product - DB row, must include category_markup_pct if no markup_pct
 * @returns {number}
 */
const computePrice = (product) => {
  if (product.sell_price && parseFloat(product.sell_price) > 0) {
    return parseFloat(product.sell_price);
  }
  const markup = parseFloat(product.markup_pct ?? product.category_markup_pct ?? 20);
  const cost   = parseFloat(product.cost_price || 0);
  return Math.round(cost * (1 + markup / 100) * 100) / 100;
};

const formatPrice = (amount, currency = 'KES') =>
  `${currency} ${parseFloat(amount).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;

// ── Categories ───────────────────────────────────────────────────────────────

/**
 * Get all active marketplace categories.
 * @returns {Promise<Array>}
 */
const getCategories = async () => {
  const res = await query(
    `SELECT id, name, slug, icon, markup_pct, display_order
     FROM marketplace_categories
     WHERE active = true
     ORDER BY display_order, name`
  );
  return res.rows;
};

/**
 * Get category by id or slug.
 * @param {number|string} idOrSlug
 * @returns {Promise<object|null>}
 */
const getCategory = async (idOrSlug) => {
  const isNum = !isNaN(idOrSlug);
  const res = await query(
    `SELECT * FROM marketplace_categories WHERE ${isNum ? 'id' : 'slug'} = $1`,
    [idOrSlug]
  );
  return res.rows[0] || null;
};

/**
 * Upsert a marketplace category.
 * @param {object} data - { name, slug, icon, markup_pct, display_order }
 * @returns {Promise<object>}
 */
const upsertCategory = async ({ id, name, slug, icon, markup_pct, display_order, active }) => {
  if (id) {
    const res = await query(
      `UPDATE marketplace_categories
       SET name=$1, icon=$2, markup_pct=$3, display_order=$4, active=$5
       WHERE id=$6 RETURNING *`,
      [name, icon || '📦', markup_pct ?? 20, display_order ?? 0, active !== false, id]
    );
    return res.rows[0];
  }
  const res = await query(
    `INSERT INTO marketplace_categories (name, slug, icon, markup_pct, display_order)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (slug) DO UPDATE SET name=$1, icon=$3, markup_pct=$4, display_order=$5
     RETURNING *`,
    [name, slug || name.toLowerCase().replace(/\s+/g, '-'), icon || '📦', markup_pct ?? 20, display_order ?? 0]
  );
  return res.rows[0];
};

// ── Products ─────────────────────────────────────────────────────────────────

/**
 * List products with pagination + optional filters.
 * @param {object} opts
 * @param {number} [opts.categoryId]
 * @param {string} [opts.search]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=PAGE_SIZE]
 * @param {boolean} [opts.featuredOnly=false]
 * @param {boolean} [opts.includeInactive=false]
 * @returns {Promise<{products: Array, total: number, pages: number}>}
 */
const getProducts = async ({
  categoryId, search, page = 1, limit = PAGE_SIZE,
  featuredOnly = false, includeInactive = false,
} = {}) => {
  const conditions = [];
  const params     = [];

  if (!includeInactive) {
    conditions.push(`p.active = true`);
    conditions.push(`p.stock_status != 'discontinued'`);
  }
  if (categoryId) {
    params.push(categoryId);
    conditions.push(`p.category_id = $${params.length}`);
  }
  if (featuredOnly) {
    conditions.push(`p.featured = true`);
  }
  if (search) {
    params.push('%' + search.toLowerCase() + '%');
    conditions.push(`(LOWER(p.name) LIKE $${params.length} OR LOWER(p.description) LIKE $${params.length})`);
  }

  const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (page - 1) * limit;

  const countRes = await query(
    `SELECT COUNT(*) FROM products p ${where}`,
    params
  );
  const total = parseInt(countRes.rows[0].count);

  params.push(limit, offset);
  const dataRes = await query(
    `SELECT p.*,
            mc.name AS category_name, mc.icon AS category_icon,
            mc.markup_pct AS category_markup_pct
     FROM products p
     LEFT JOIN marketplace_categories mc ON p.category_id = mc.id
     ${where}
     ORDER BY p.featured DESC, p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const products = dataRes.rows.map(p => ({ ...p, computed_price: computePrice(p) }));
  return { products, total, pages: Math.ceil(total / limit), page };
};

/**
 * Get a single product with computed price.
 * @param {number} id
 * @returns {Promise<object|null>}
 */
const getProduct = async (id) => {
  const res = await query(
    `SELECT p.*,
            mc.name AS category_name, mc.icon AS category_icon,
            mc.markup_pct AS category_markup_pct
     FROM products p
     LEFT JOIN marketplace_categories mc ON p.category_id = mc.id
     WHERE p.id = $1`,
    [id]
  );
  if (!res.rows[0]) return null;
  const p = res.rows[0];
  return { ...p, computed_price: computePrice(p) };
};

/**
 * Create a product.
 * @param {object} data
 * @returns {Promise<object>}
 */
const createProduct = async ({
  sku, source_id, external_id, category_id, name, description,
  image_url, cost_price, markup_pct, sell_price, currency,
  stock_status, supplier_url, shipping_info, attributes, featured,
}) => {
  const autoSku = sku || 'PRD-' + Date.now();
  const res = await query(
    `INSERT INTO products
       (sku, source_id, external_id, category_id, name, description,
        image_url, cost_price, markup_pct, sell_price, currency,
        stock_status, supplier_url, shipping_info, attributes, featured)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      autoSku, source_id || null, external_id || null, category_id || null,
      name, description || null, image_url || null,
      cost_price || 0, markup_pct || null, sell_price || null,
      currency || 'KES', stock_status || 'in_stock',
      supplier_url || null, shipping_info || null,
      JSON.stringify(attributes || {}), featured || false,
    ]
  );
  logger.info('catalog: product created', { id: res.rows[0].id, name });
  return res.rows[0];
};

/**
 * Update a product.
 * @param {number} id
 * @param {object} data
 * @returns {Promise<object>}
 */
const updateProduct = async (id, data) => {
  const fields = [];
  const vals   = [];
  const allowed = [
    'name','description','image_url','cost_price','markup_pct','sell_price',
    'currency','stock_status','supplier_url','shipping_info','attributes',
    'featured','active','category_id','shipping_info',
  ];
  for (const [k, v] of Object.entries(data)) {
    if (allowed.includes(k)) {
      vals.push(k === 'attributes' ? JSON.stringify(v) : v);
      fields.push(`${k} = $${vals.length}`);
    }
  }
  if (!fields.length) throw new Error('No updatable fields provided');
  vals.push(id);
  const res = await query(
    `UPDATE products SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  return res.rows[0];
};

/**
 * Bulk upsert products (used by fetcher after external sync).
 * Deduplicates on (source_id, external_id).
 * @param {Array<object>} items
 * @returns {Promise<{inserted: number, updated: number}>}
 */
const bulkUpsert = async (items) => {
  let inserted = 0, updated = 0;
  for (const item of items) {
    try {
      if (item.source_id && item.external_id) {
        const existing = await query(
          `SELECT id FROM products WHERE source_id = $1 AND external_id = $2`,
          [item.source_id, item.external_id]
        );
        if (existing.rows.length) {
          await updateProduct(existing.rows[0].id, item);
          updated++;
        } else {
          await createProduct(item);
          inserted++;
        }
      } else {
        await createProduct(item);
        inserted++;
      }
    } catch (err) {
      logger.warn('catalog: bulkUpsert row failed', { name: item.name, error: err.message });
    }
  }
  logger.info('catalog: bulkUpsert done', { inserted, updated });
  return { inserted, updated };
};

// ── WhatsApp message builders ─────────────────────────────────────────────────

/**
 * Build a WhatsApp list-message payload for categories.
 * @param {Array} categories
 * @returns {object} Evolution API list payload
 */
const buildCategoryList = (categories) => ({
  title:       '🛍️ Laitor Shop',
  description: 'What are you looking for today?',
  buttonText:  'Browse Categories',
  sections: [{
    title: 'Categories',
    rows: categories.map(c => ({
      rowId:       `CAT_${c.id}`,
      title:       `${c.icon} ${c.name}`,
      description: '',
    })),
  }],
});

/**
 * Build a WhatsApp list-message payload for products on a page.
 * @param {Array}  products
 * @param {number} page
 * @param {number} pages
 * @param {string} categoryName
 * @returns {object}
 */
const buildProductList = (products, page, pages, categoryName) => {
  const rows = products.map(p => ({
    rowId:       `PRD_${p.id}`,
    title:       p.name.substring(0, 24),
    description: formatPrice(p.computed_price, p.currency),
  }));

  // Pagination controls as extra rows
  if (page > 1)   rows.push({ rowId: `PAGE_PREV_${page - 1}`, title: '⬅ Previous page', description: '' });
  if (page < pages) rows.push({ rowId: `PAGE_NEXT_${page + 1}`, title: '➡ Next page',     description: '' });
  rows.push({ rowId: 'CART_VIEW', title: '🛒 View Cart', description: '' });
  rows.push({ rowId: 'SHOP_MENU', title: '🏠 Back to Categories', description: '' });

  return {
    title:       `${categoryName} (${page}/${pages})`,
    description: 'Select a product to view details',
    buttonText:  'View Products',
    sections: [{ title: 'Products', rows }],
  };
};

/**
 * Build a product detail text message + button payload.
 * @param {object} product
 * @returns {{ text: string, buttons: Array }}
 */
const buildProductDetail = (product) => {
  const price = formatPrice(product.computed_price, product.currency);
  const lines = [
    `*${product.name}*`,
    '',
    `💰 *Price: ${price}*`,
  ];
  if (product.category_name) lines.push(`📂 ${product.category_icon || '📦'} ${product.category_name}`);
  if (product.shipping_info)  lines.push(`🚚 ${product.shipping_info}`);
  if (product.description)    lines.push('', product.description.substring(0, 300));

  return {
    text: lines.join('\n'),
    buttons: [
      { buttonId: `ADD_CART_${product.id}`, buttonText: { displayText: '🛒 Add to Cart' }, type: 1 },
      { buttonId: 'CART_VIEW',              buttonText: { displayText: '🛒 View Cart'    }, type: 1 },
      { buttonId: 'SHOP_BACK',              buttonText: { displayText: '↩ Back'           }, type: 1 },
    ],
  };
};

module.exports = {
  // Categories
  getCategories, getCategory, upsertCategory,
  // Products
  getProducts, getProduct, createProduct, updateProduct, bulkUpsert,
  // Helpers
  computePrice, formatPrice,
  // WA builders
  buildCategoryList, buildProductList, buildProductDetail,
};
