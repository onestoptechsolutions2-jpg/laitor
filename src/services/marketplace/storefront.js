'use strict';

/**
 * @module marketplace/storefront
 * @description Public web storefront — generates SEO-friendly HTML pages.
 *
 * Routes (added to Express):
 *   GET /shop                → category listing
 *   GET /shop/:categorySlug  → product grid for category
 *   GET /shop/product/:id    → product detail page with WA link
 */

const catalog = require('./catalog');

const BRAND   = process.env.BUSINESS_NAME  || 'Laitor Shop';
const WA_NUM  = process.env.WHATSAPP_NUMBER || '';
const PRIMARY = '#6366f1';

const css = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;color:#111;background:#f9f9f9}
  .topbar{background:${PRIMARY};color:#fff;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
  .topbar a{color:#fff;text-decoration:none;font-weight:700;font-size:18px}
  .topbar .wa-btn{background:#25d366;color:#fff;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;text-decoration:none}
  .hero{background:${PRIMARY};color:#fff;padding:32px 24px;text-align:center}
  .hero h1{font-size:28px;margin-bottom:8px}
  .hero p{font-size:15px;opacity:.85}
  .container{max-width:1100px;margin:0 auto;padding:24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;margin-top:20px}
  .card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);transition:transform .15s}
  .card:hover{transform:translateY(-2px)}
  .card img{width:100%;height:180px;object-fit:cover;background:#f3f4f6}
  .card-no-img{width:100%;height:180px;background:linear-gradient(135deg,#ede9fe,#dbeafe);display:flex;align-items:center;justify-content:center;font-size:40px}
  .card-body{padding:14px}
  .card-cat{font-size:11px;color:#6366f1;font-weight:700;text-transform:uppercase;margin-bottom:4px}
  .card-name{font-size:14px;font-weight:700;margin-bottom:6px;line-height:1.3}
  .card-price{font-size:16px;font-weight:800;color:#22c55e}
  .card-ship{font-size:11px;color:#888;margin-top:4px}
  .wa-link{display:block;margin-top:12px;background:#25d366;color:#fff;text-align:center;padding:9px;border-radius:8px;font-weight:700;font-size:13px;text-decoration:none}
  .cat-chips{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}
  .chip{padding:8px 16px;border-radius:20px;background:#fff;border:1.5px solid #e5e5e5;font-size:13px;font-weight:600;text-decoration:none;color:#444;transition:all .15s}
  .chip:hover,.chip.active{background:${PRIMARY};border-color:${PRIMARY};color:#fff}
  .breadcrumb{font-size:13px;color:#888;margin-bottom:16px}
  .breadcrumb a{color:${PRIMARY};text-decoration:none}
  .detail-wrap{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:20px}
  .detail-img img{width:100%;border-radius:12px;object-fit:cover;max-height:400px}
  .detail-price{font-size:28px;font-weight:900;color:#22c55e;margin:12px 0}
  .detail-desc{font-size:14px;line-height:1.7;color:#555;margin-top:12px}
  .detail-meta{margin-top:16px;font-size:13px;color:#666}
  .detail-meta div{margin-bottom:6px}
  .big-wa{display:block;background:#25d366;color:#fff;text-align:center;padding:16px;border-radius:10px;
    font-weight:800;font-size:16px;text-decoration:none;margin-top:20px}
  footer{text-align:center;padding:32px;font-size:13px;color:#aaa;margin-top:32px}
  @media(max-width:600px){.detail-wrap{grid-template-columns:1fr}}
`;

const layout = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — ${BRAND}</title>
<meta name="description" content="Shop ${title} at ${BRAND}. WhatsApp-first shopping experience.">
<style>${css}</style>
</head>
<body>
<div class="topbar">
  <a href="/shop">${BRAND}</a>
  ${WA_NUM ? `<a class="wa-btn" href="https://wa.me/${WA_NUM}?text=SHOP" target="_blank">💬 Chat to Order</a>` : ''}
</div>
${body}
<footer>© ${new Date().getFullYear()} ${BRAND} · <a href="https://wa.me/${WA_NUM}" style="color:#6366f1">WhatsApp Us</a></footer>
</body>
</html>`;

const waOrderLink = (product) => {
  const text = encodeURIComponent('I want to order: ' + product.name + ' (KES ' + catalog.formatPrice(product.computed_price, product.currency) + ')');
  return WA_NUM ? `https://wa.me/${WA_NUM}?text=${text}` : '#';
};

// ── Pages ─────────────────────────────────────────────────────────────────────

const renderHome = async () => {
  const cats = await catalog.getCategories();
  const featured = await catalog.getProducts({ featuredOnly: true, limit: 8 });

  const catHtml = cats.map(c =>
    `<a class="chip" href="/shop/${c.slug}">${c.icon} ${c.name}</a>`
  ).join('');

  const prodHtml = featured.products.map(p =>
    `<a class="card" href="/shop/product/${p.id}" style="text-decoration:none;color:inherit">
      ${p.image_url ? `<img src="${p.image_url}" alt="${p.name}" loading="lazy">` : `<div class="card-no-img">${p.category_icon||'📦'}</div>`}
      <div class="card-body">
        <div class="card-cat">${p.category_name||''}</div>
        <div class="card-name">${p.name}</div>
        <div class="card-price">KES ${parseFloat(p.computed_price).toLocaleString('en-KE')}</div>
        ${p.shipping_info ? `<div class="card-ship">🚚 ${p.shipping_info}</div>` : ''}
      </div>
    </a>`
  ).join('');

  return layout(BRAND,
    `<div class="hero"><h1>🛍️ ${BRAND}</h1><p>WhatsApp-first shopping. Browse, order, pay — all on WhatsApp.</p></div>
     <div class="container">
       <div class="cat-chips">${catHtml}</div>
       ${featured.products.length ? `<h2 style="font-size:16px;font-weight:700;margin-top:8px">⭐ Featured Products</h2><div class="grid">${prodHtml}</div>` : ''}
     </div>`
  );
};

const renderCategory = async (slug) => {
  const cat = await catalog.getCategory(slug);
  if (!cat) return null;
  const { products, total, pages } = await catalog.getProducts({ categoryId: cat.id, limit: 24 });

  const prodHtml = products.map(p =>
    `<a class="card" href="/shop/product/${p.id}" style="text-decoration:none;color:inherit">
      ${p.image_url ? `<img src="${p.image_url}" alt="${p.name}" loading="lazy">` : `<div class="card-no-img">${cat.icon}</div>`}
      <div class="card-body">
        <div class="card-name">${p.name}</div>
        <div class="card-price">KES ${parseFloat(p.computed_price).toLocaleString('en-KE')}</div>
        ${p.shipping_info ? `<div class="card-ship">🚚 ${p.shipping_info}</div>` : ''}
        <a class="wa-link" href="${waOrderLink(p)}" onclick="event.stopPropagation()">💬 Order on WhatsApp</a>
      </div>
    </a>`
  ).join('');

  return layout(cat.icon + ' ' + cat.name,
    `<div class="container">
       <div class="breadcrumb"><a href="/shop">Shop</a> › ${cat.name} (${total})</div>
       <div class="grid">${prodHtml || '<p style="color:#888;padding:32px 0">No products in this category yet.</p>'}</div>
     </div>`
  );
};

const renderProduct = async (productId) => {
  const p = await catalog.getProduct(productId);
  if (!p || !p.active) return null;

  return layout(p.name,
    `<div class="container">
       <div class="breadcrumb">
         <a href="/shop">Shop</a> ›
         ${p.category_name ? `<a href="/shop/${p.slug||''}">  ${p.category_name}</a> › ` : ''}
         ${p.name}
       </div>
       <div class="detail-wrap">
         <div class="detail-img">
           ${p.image_url ? `<img src="${p.image_url}" alt="${p.name}">` : `<div class="card-no-img" style="height:360px;border-radius:12px;font-size:64px">${p.category_icon||'📦'}</div>`}
         </div>
         <div>
           <h1 style="font-size:22px;font-weight:800;line-height:1.3">${p.name}</h1>
           <div class="detail-price">KES ${parseFloat(p.computed_price).toLocaleString('en-KE', { minimumFractionDigits: 2 })}</div>
           ${p.description ? `<div class="detail-desc">${p.description}</div>` : ''}
           <div class="detail-meta">
             ${p.shipping_info ? `<div>🚚 <strong>Shipping:</strong> ${p.shipping_info}</div>` : ''}
             ${p.stock_status === 'in_stock' ? '<div>✅ <strong>In Stock</strong></div>' : '<div>❌ Out of Stock</div>'}
           </div>
           <a class="big-wa" href="${waOrderLink(p)}" target="_blank">
             💬 Order on WhatsApp
           </a>
           ${p.supplier_url ? `<div style="margin-top:10px;font-size:12px;color:#aaa;text-align:center"><a href="${p.supplier_url}" target="_blank" style="color:#aaa">View original listing ↗</a></div>` : ''}
         </div>
       </div>
     </div>`
  );
};

module.exports = { renderHome, renderCategory, renderProduct };
