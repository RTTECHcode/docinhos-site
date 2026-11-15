'use strict';
// F6 M1: /api/health na Netlify. O handler é o mesmo de api/health.js; o adaptador faz a ponte (netlify/lib/adapter.js).
const { createHandler } = require('../lib/adapter');
exports.handler = createHandler(require('../../api/health'), 'health');
