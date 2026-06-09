'use strict';
// Replaced by local JWT auth — see src/middleware/adminAuth.js
const supabaseAuth = (req,res,next) => next();
const requireManager = (req,res,next) => next();
module.exports = { supabaseAuth, requireManager };
