// Full-window preview of the diorama. Append ?t=<seconds> to freeze a single moment
// (the site's poster is ?t=9 in a 900px square, the moment the live hero starts from).
import { mount } from './main.js';

const box = document.createElement('div');
Object.assign(box.style, { position: 'fixed', inset: '0' });
document.body.appendChild(box);
const t = new URLSearchParams(location.search).get('t');
mount(box, t !== null ? { frozenAt: +t } : {});
