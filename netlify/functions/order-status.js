'use strict';
// F6 M1: /api/order-status na Netlify. O handler é o mesmo de api/order-status.js; o adaptador faz a ponte (netlify/lib/adapter.js).
const { createHandler } = require('../lib/adapter');
exports.handler = createHandler(require('../../api/order-status'), 'order-status');
