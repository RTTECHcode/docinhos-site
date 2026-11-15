'use strict';
// F6 M1: /api/img na Netlify. O handler é o mesmo de api/img.js; o adaptador faz a ponte (netlify/lib/adapter.js).
const { createHandler } = require('../lib/adapter');
exports.handler = createHandler(require('../../api/img'), 'img');
