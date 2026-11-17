'use strict';
// F6 M1: /api/mp-webhook na Netlify. O handler é o mesmo de api/mp-webhook.js; o adaptador faz a ponte (netlify/lib/adapter.js).
const { createHandler } = require('../lib/adapter');
exports.handler = createHandler(require('../../api/mp-webhook'), 'mp-webhook');
